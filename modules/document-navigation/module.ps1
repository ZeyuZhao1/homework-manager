$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$moduleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataRoot = Join-Path $moduleRoot 'data'
$cachePath = Join-Path $dataRoot 'index.json'

function Write-ProtocolResult([object]$result) {
    $json = @{ protocol = 1; ok = $true; result = $result } | ConvertTo-Json -Depth 12 -Compress
    [Console]::Out.Write($json)
}

function Write-ProtocolError([string]$message) {
    $json = @{ protocol = 1; ok = $false; error = $message } | ConvertTo-Json -Depth 4 -Compress
    [Console]::Out.Write($json)
}

function Get-FileFingerprint([string]$path) {
    $item = Get-Item -LiteralPath $path -ErrorAction Stop
    return "$($item.Length):$($item.LastWriteTimeUtc.Ticks)"
}

function Load-Index {
    if (-not (Test-Path -LiteralPath $cachePath -PathType Leaf)) {
        return [pscustomobject]@{ version = 1; files = @() }
    }
    try {
        $cache = Get-Content -LiteralPath $cachePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cache.version -ne 1 -or $null -eq $cache.files) { throw 'unsupported cache' }
        return $cache
    } catch {
        return [pscustomobject]@{ version = 1; files = @() }
    }
}

function Save-Index([object[]]$files) {
    [System.IO.Directory]::CreateDirectory($dataRoot) | Out-Null
    $json = @{ version = 1; files = @($files) } | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($cachePath, $json, [System.Text.UTF8Encoding]::new($false))
}

function Normalize-Heading([string]$value) {
    if ($null -eq $value) { return '' }
    return ([regex]::Replace($value.ToLowerInvariant(), '[\s\p{P}\p{S}]', ''))
}

function Read-DocxHeadings([string]$path) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($path)
    try {
        $entry = $archive.GetEntry('word/document.xml')
        if ($null -eq $entry) { return @() }
        $reader = [System.IO.StreamReader]::new($entry.Open(), [System.Text.Encoding]::UTF8)
        try { [xml]$document = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $namespaces = [System.Xml.XmlNamespaceManager]::new($document.NameTable)
        $namespaces.AddNamespace('w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')
        $headings = @()
        foreach ($paragraph in $document.SelectNodes('//w:p', $namespaces)) {
            $style = $paragraph.SelectSingleNode('./w:pPr/w:pStyle', $namespaces)
            if ($null -eq $style) { continue }
            $styleName = $style.GetAttribute('val', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')
            if ($styleName -match '^Heading([1-9])$') { $level = [int]$Matches[1] } else { continue }
            $text = (($paragraph.SelectNodes('.//w:t', $namespaces) | ForEach-Object { $_.InnerText }) -join '').Trim()
            if ($text) { $headings += [pscustomobject]@{ title = $text; level = $level; target = $text; page = $null } }
        }
        return @($headings)
    } finally {
        $archive.Dispose()
    }
}

function Decode-PdfTitle([string]$value) {
    $decoded = $value -replace '\\([\\()])', '$1'
    $decoded = $decoded -replace '\\n', ' ' -replace '\\r', ' ' -replace '\\t', ' '
    return $decoded.Trim()
}

function Read-PdfHeadings([string]$path) {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $text = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)
    $pageNumbers = @{}
    $pagePattern = [regex]::new('(?s)(?<object>\d+)\s+\d+\s+obj\s*<<(?:(?!endobj).)*?/Type\s*/Page\b')
    $number = 1
    foreach ($match in $pagePattern.Matches($text)) {
        $pageNumbers[$match.Groups['object'].Value] = $number
        $number++
    }
    $headings = @()
    $outlinePattern = [regex]::new('(?s)/Title\s*\((?<title>(?:\\.|[^\\)])*)\)(?:(?!endobj).){0,2500}?(?:/Dest\s*\[|/D\s*\[)\s*(?<page>\d+)\s+\d+\s+R')
    foreach ($match in $outlinePattern.Matches($text)) {
        $page = $pageNumbers[$match.Groups['page'].Value]
        $title = Decode-PdfTitle $match.Groups['title'].Value
        if ($title -and $page) { $headings += [pscustomobject]@{ title = $title; level = 1; target = ''; page = [int]$page } }
    }
    return @($headings)
}

function Read-HtmlHeadings([string]$path) {
    $text = [System.IO.File]::ReadAllText($path)
    $pattern = [regex]::new('(?is)<h(?<level>[1-6])(?<attributes>[^>]*)>(?<text>.*?)</h\k<level>>')
    $headings = @()
    foreach ($match in $pattern.Matches($text)) {
        $idMatch = [regex]::Match($match.Groups['attributes'].Value, '(?i)\bid\s*=\s*["''](?<id>[^"'']+)["'']')
        if (-not $idMatch.Success) { continue }
        $title = [System.Net.WebUtility]::HtmlDecode(([regex]::Replace($match.Groups['text'].Value, '<[^>]+>', ''))).Trim()
        if ($title) { $headings += [pscustomobject]@{ title = $title; level = [int]$match.Groups['level'].Value; target = $idMatch.Groups['id'].Value; page = $null } }
    }
    return @($headings)
}

function Build-IndexEntry([string]$path) {
    $extension = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
    $headings = switch ($extension) {
        '.docx' { @(Read-DocxHeadings $path); break }
        '.pdf' { @(Read-PdfHeadings $path); break }
        '.html' { @(Read-HtmlHeadings $path); break }
        '.htm' { @(Read-HtmlHeadings $path); break }
        default { @() }
    }
    return [pscustomobject]@{
        path = [System.IO.Path]::GetFullPath($path)
        fingerprint = Get-FileFingerprint $path
        format = $extension.TrimStart('.')
        indexed_at = [DateTime]::UtcNow.ToString('o')
        headings = @($headings)
    }
}

function Find-Heading([object]$entry, [string]$chapter) {
    $needle = Normalize-Heading $chapter
    if (-not $needle) { return $null }
    $exact = @($entry.headings | Where-Object { (Normalize-Heading $_.title) -eq $needle }) | Select-Object -First 1
    if ($exact) { return $exact }
    return @($entry.headings | Where-Object { (Normalize-Heading $_.title).Contains($needle) -or $needle.Contains((Normalize-Heading $_.title)) }) | Select-Object -First 1
}

function Get-FirstPage([string]$value) {
    $match = [regex]::Match($value, '\d+')
    if ($match.Success) { return [int]$match.Value }
    return $null
}

function Invoke-Index([object]$inputValue) {
    $cache = Load-Index
    $files = @($cache.files)
    $indexed = 0
    $cached = 0
    $skipped = 0
    foreach ($file in @($inputValue.files)) {
        $path = [string]$file.path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $skipped++; continue }
        $extension = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
        if ($extension -notin @('.pdf', '.docx', '.html', '.htm')) { $skipped++; continue }
        $fullPath = [System.IO.Path]::GetFullPath($path)
        $fingerprint = Get-FileFingerprint $fullPath
        $existing = @($files | Where-Object { $_.path -eq $fullPath }) | Select-Object -First 1
        if ($existing -and $existing.fingerprint -eq $fingerprint) { $cached++; continue }
        $files = @($files | Where-Object { $_.path -ne $fullPath })
        $files += Build-IndexEntry $fullPath
        $indexed++
    }
    Save-Index $files
    return @{ indexed = $indexed; cached = $cached; skipped = $skipped }
}

function Open-Pdf([string]$path, [Nullable[int]]$page, [string]$chapter, [object]$entry) {
    $targetPage = $page
    if (-not $targetPage -and $chapter -and $entry) {
        $heading = Find-Heading $entry $chapter
        if ($heading -and $heading.page) { $targetPage = [int]$heading.page }
    }
    if (-not $targetPage) {
        Start-Process -FilePath $path
        return @{ handled = $true; location_applied = $false; warning = 'The requested chapter was not found in the PDF outline; the first page was opened.' }
    }
    $uri = ([System.Uri]::new($path)).AbsoluteUri + "#page=$targetPage"
    Start-Process -FilePath $uri
    return @{ handled = $true; location_applied = $true; warning = $null }
}

function Open-Word([string]$path, [Nullable[int]]$page, [string]$chapter, [object]$entry) {
    try {
        $word = New-Object -ComObject Word.Application
        $document = $word.Documents.Open($path, $false, $true)
        $word.Visible = $true
        $document.Activate()
        if ($page) {
            $range = $document.GoTo(1, 1, [int]$page)
            $range.Select()
            return @{ handled = $true; location_applied = $true; warning = $null }
        }
        $target = $chapter
        if ($entry) {
            $heading = Find-Heading $entry $chapter
            if ($heading) { $target = [string]$heading.target }
        }
        if ($target) {
            $range = $document.Content.Duplicate
            $range.Find.Text = $target
            $range.Find.Forward = $true
            $range.Find.Wrap = 0
            if ($range.Find.Execute()) {
                $range.Select()
                return @{ handled = $true; location_applied = $true; warning = $null }
            }
        }
        return @{ handled = $true; location_applied = $false; warning = 'The requested chapter was not found in the Word document; the document start was opened.' }
    } catch {
        Start-Process -FilePath $path
        return @{ handled = $true; location_applied = $false; warning = "Word navigation failed; the document was opened normally: $($_.Exception.Message)" }
    }
}

function Open-Html([string]$path, [string]$chapter, [object]$entry) {
    $heading = if ($entry) { Find-Heading $entry $chapter } else { $null }
    $uri = ([System.Uri]::new($path)).AbsoluteUri
    if ($heading -and $heading.target) {
        $uri += '#' + [System.Uri]::EscapeDataString([string]$heading.target)
        Start-Process -FilePath $uri
        return @{ handled = $true; location_applied = $true; warning = $null }
    }
    Start-Process -FilePath $uri
    return @{ handled = $true; location_applied = $false; warning = 'The requested chapter was not found in the HTML outline; the document start was opened.' }
}

function Invoke-Open([object]$inputValue) {
    $path = [string]$inputValue.path
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'The file does not exist.' }
    $extension = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
    if ($extension -notin @('.pdf', '.docx', '.doc', '.html', '.htm')) { return @{ handled = $false; location_applied = $false; warning = $null } }
    $fullPath = [System.IO.Path]::GetFullPath($path)
    $cache = Load-Index
    $entry = @($cache.files | Where-Object { $_.path -eq $fullPath }) | Select-Object -First 1
    if ($extension -ne '.doc' -and ((-not $entry) -or $entry.fingerprint -ne (Get-FileFingerprint $fullPath))) {
        $files = @($cache.files | Where-Object { $_.path -ne $fullPath })
        $entry = Build-IndexEntry $fullPath
        $files += $entry
        Save-Index $files
    }
    $page = Get-FirstPage ([string]$inputValue.page)
    $chapter = ([string]$inputValue.chapter).Trim()
    switch ($extension) {
        '.pdf' { return Open-Pdf $fullPath $page $chapter $entry }
        '.docx' { return Open-Word $fullPath $page $chapter $entry }
        '.doc' { return Open-Word $fullPath $page $chapter $null }
        '.html' { return Open-Html $fullPath $chapter $entry }
        '.htm' { return Open-Html $fullPath $chapter $entry }
    }
}

try {
    $requestText = [Console]::In.ReadToEnd()
    $request = $requestText | ConvertFrom-Json
    if ($request.protocol -ne 1) { throw 'Unsupported module protocol version.' }
    switch ([string]$request.capability) {
        'document.navigation.index' { Write-ProtocolResult (Invoke-Index $request.input) }
        'document.navigation.open' { Write-ProtocolResult (Invoke-Open $request.input) }
        default { throw 'Unsupported capability.' }
    }
} catch {
    Write-ProtocolError $_.Exception.Message
}

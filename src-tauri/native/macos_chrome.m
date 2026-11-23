#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

#if __MAC_OS_X_VERSION_MAX_ALLOWED < 260000
#error "Homeworkbook macOS chrome requires the macOS 26 SDK or newer; deployment target remains macOS 11.0."
#endif

bool homeworkbook_place_macos_window(void *windowPointer) {
    if (![NSThread isMainThread] || !windowPointer) return false;
    NSWindow *window = (__bridge NSWindow *)windowPointer;
    NSScreen *target = nil;
    NSPoint pointer = NSEvent.mouseLocation;
    for (NSScreen *screen in NSScreen.screens) {
        if (NSPointInRect(pointer, screen.frame)) {
            target = screen;
            break;
        }
    }
    target = target ?: window.screen ?: NSScreen.mainScreen;
    if (!target) return false;

    // Screen and window frames are both in global AppKit points, even when
    // the current and destination displays have different backing scales.
    NSRect area = target.visibleFrame;
    CGFloat width = floor(MIN(1060.0, NSWidth(area) * 0.83));
    CGFloat height = floor(MIN(740.0, NSHeight(area) * 0.87));
    if (width < 1 || height < 1) return false;
    NSRect frame = NSMakeRect(round(NSMidX(area) - width / 2), round(NSMidY(area) - height / 2), width, height);
    window.minSize = NSMakeSize(MIN(710.0, width), MIN(500.0, height));
    [window setFrame:frame display:NO];
    return true;
}

static NSString *const HBSearch = @"homeworkbook.search";
static NSString *const HBAdd = @"homeworkbook.add";
static NSString *const HBFilter = @"homeworkbook.filter";
static NSString *const HBTools = @"homeworkbook.tools";

static NSDictionary *HBRow(NSString *name, NSString *action, NSString *value, NSString *symbol) {
    return @{ @"name": name, @"action": action, @"value": value, @"symbol": symbol };
}

@interface HBSidebarTable : NSTableView
@property(nonatomic, copy) NSMenu *(^courseMenuForRow)(NSInteger);
@end

@implementation HBSidebarTable
- (NSMenu *)menuForEvent:(NSEvent *)event {
    NSInteger row = [self rowAtPoint:[self convertPoint:event.locationInWindow fromView:nil]];
    return self.courseMenuForRow ? self.courseMenuForRow(row) : nil;
}
@end

API_AVAILABLE(macos(26.0))
@interface HBCapsuleButtonView : NSGlassEffectView
@end

@implementation HBCapsuleButtonView
- (void)layout {
    [super layout];
    CGFloat radius = MIN(NSWidth(self.bounds), NSHeight(self.bounds)) / 2;
    if (self.cornerRadius != radius) self.cornerRadius = radius;
    if (!NSEqualRects(self.contentView.frame, self.bounds)) self.contentView.frame = self.bounds;
}
@end

@interface HBOpaquePopupSurface : NSView
@end

@implementation HBOpaquePopupSurface
- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;
    // Only this control covers the scrolling content. The popup itself
    // retains its native appearance and keyboard/menu behavior.
    [[NSColor.windowBackgroundColor colorWithAlphaComponent:1] setFill];
    CGFloat radius = NSHeight(self.bounds) / 2;
    [[NSBezierPath bezierPathWithRoundedRect:self.bounds xRadius:radius yRadius:radius] fill];
}
- (void)viewDidChangeEffectiveAppearance {
    [super viewDidChangeEffectiveAppearance];
    self.needsDisplay = YES;
}
@end

@interface HBCenteredPullDownCell : NSPopUpButtonCell
@end

@implementation HBCenteredPullDownCell
- (NSRect)titleRectForBounds:(NSRect)bounds {
    NSRect title = [super titleRectForBounds:bounds];
    // Reserve the arrow inset on both sides so the title centers in the capsule.
    CGFloat inset = MAX(NSMinX(title) - NSMinX(bounds), NSMaxX(bounds) - NSMaxX(title));
    title.origin.x = NSMinX(bounds) + inset;
    title.size.width = MAX(0, NSWidth(bounds) - 2 * inset);
    return title;
}
@end

static NSView *HBButtonSurface(NSButton *button) {
    button.bezelStyle = NSBezelStylePush;
    if (@available(macOS 26.0, *)) {
        HBCapsuleButtonView *surface = [HBCapsuleButtonView new];
        button.bordered = NO;
        button.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        surface.contentView = button;
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 270000
        if (@available(macOS 27.0, *)) surface.effectIsInteractive = YES;
#endif
        return surface;
    }
    return button;
}

@interface HBChrome : NSObject <NSToolbarDelegate, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate, NSMenuItemValidation>
@property(nonatomic, weak) NSWindow *window;
@property(nonatomic, weak) WKWebView *webview;
@property(nonatomic, strong) NSSplitViewController *split;
@property(nonatomic, strong) NSPopUpButton *semesters;
@property(nonatomic, strong) NSTableView *table;
@property(nonatomic, strong) NSButton *addCourse;
@property(nonatomic, strong) NSButton *themeButton;
@property(nonatomic, strong) NSSearchToolbarItem *searchItem;
@property(nonatomic, strong) NSToolbarItem *addItem;
@property(nonatomic, strong) NSMenuToolbarItem *filterItem;
@property(nonatomic, strong) NSMenuToolbarItem *toolsItem;
@property(nonatomic, strong) NSStatusItem *statusItem;
@property(nonatomic, copy) NSDictionary *assignmentFilter;
@property(nonatomic, copy) NSArray<NSDictionary *> *tools;
@property(nonatomic, copy) NSString *theme;
@property(nonatomic, copy) NSArray<NSDictionary *> *rows;
@property(nonatomic, copy) NSArray<NSDictionary *> *semesterData;
@property(nonatomic, assign) BOOL blocked;
@property(nonatomic, assign) BOOL showSearch;
@property(nonatomic, assign) BOOL showAdd;
@property(nonatomic, assign) BOOL canAdd;
@property(nonatomic, assign) BOOL showPlans;
@property(nonatomic, assign) BOOL pendingSearchFocus;
@property(nonatomic, copy) NSString *activeView;
@property(nonatomic, strong) NSNumber *lastReset;
- (instancetype)initWithWindow:(NSWindow *)window webview:(WKWebView *)webview;
- (NSMenu *)courseMenuForRow:(NSInteger)row;
- (void)apply:(NSDictionary *)state;
@end

@implementation HBChrome
- (void)send:(NSString *)action value:(NSString *)value {
    if (self.blocked || !self.webview) return;
    NSMutableDictionary *detail = [@{ @"action": action, @"value": value ?: @"" } mutableCopy];
    // AppKit can publish a final search when focus leaves the field. React
    // ignores results from before its most recent clear or navigation.
    if ([action isEqualToString:@"search"]) detail[@"searchReset"] = self.lastReset ?: @0;
    NSData *data = [NSJSONSerialization dataWithJSONObject:detail options:NSJSONWritingFragmentsAllowed error:nil];
    if (!data) return;
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSString *script = [NSString stringWithFormat:@"window.dispatchEvent(new CustomEvent('homeworkbook:macos-chrome-action',{detail:%@}))", json];
    [self.webview evaluateJavaScript:script completionHandler:nil];
}
- (instancetype)initWithWindow:(NSWindow *)window webview:(WKWebView *)webview {
    self = [super init];
    if (!self) return nil;
    _window = window;
    _webview = webview;
    _rows = @[];
    _semesterData = @[];

    NSRect frame = window.frame;
    NSSize minimum = window.minSize;
    NSView *original = window.contentView;
    if (!original) return nil;
    NSViewController *content = [NSViewController new];
    NSView *contentPane = [[NSView alloc] initWithFrame:original.frame];
    content.view = contentPane;
    NSViewController *sidebar = [NSViewController new];
    NSView *sideView = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 230, 600)];
    sidebar.view = sideView;
    _split = [NSSplitViewController new];
    NSSplitViewItem *sideItem = [NSSplitViewItem sidebarWithViewController:sidebar];
    sideItem.minimumThickness = 218;
    sideItem.maximumThickness = 300;
    sideItem.canCollapse = YES;
    sideItem.collapseBehavior = NSSplitViewItemCollapseBehaviorPreferResizingSiblingsWithFixedSplitView;
    [_split addSplitViewItem:sideItem];
    [_split addSplitViewItem:[NSSplitViewItem splitViewItemWithViewController:content]];
    // Set the replacement root before reparenting Wry so Tao's window delegate
    // always has a contentView during AppKit's synchronous layout callbacks.
    window.contentViewController = _split;
    original.frame = contentPane.bounds;
    original.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [contentPane addSubview:original];

    _semesters = [[NSPopUpButton alloc] initWithFrame:NSZeroRect pullsDown:NO];
    _semesters.controlSize = NSControlSizeLarge;
    _semesters.font = [NSFont systemFontOfSize:14 weight:NSFontWeightMedium];
    _semesters.toolTip = @"选择学期";
    [_semesters setAccessibilityLabel:@"选择学期"];
    HBSidebarTable *table = [[HBSidebarTable alloc] initWithFrame:NSZeroRect];
    __weak HBChrome *weakSelf = self;
    table.courseMenuForRow = ^NSMenu *(NSInteger row) { return [weakSelf courseMenuForRow:row]; };
    _table = table;
    NSTableColumn *column = [[NSTableColumn alloc] initWithIdentifier:@"navigation"];
    column.resizingMask = NSTableColumnAutoresizingMask;
    [_table addTableColumn:column];
    _table.columnAutoresizingStyle = NSTableViewUniformColumnAutoresizingStyle;
    _table.headerView = nil;
    _table.style = NSTableViewStyleSourceList;
    _table.backgroundColor = NSColor.clearColor;
    _table.rowHeight = 32;
    _table.delegate = self;
    _table.dataSource = self;
    [_table setAccessibilityLabel:@"导航与课程"];
    NSScrollView *scroll = [NSScrollView new];
    scroll.documentView = _table;
    scroll.hasVerticalScroller = YES;
    scroll.autohidesScrollers = YES;
    scroll.drawsBackground = NO;
    _addCourse = [NSButton buttonWithTitle:@"添加课程" target:self action:@selector(addCourseAction:)];
    _addCourse.font = [NSFont systemFontOfSize:14 weight:NSFontWeightMedium];
    _addCourse.image = [NSImage imageWithSystemSymbolName:@"plus" accessibilityDescription:nil];
    _addCourse.imagePosition = NSImageLeft;
    _addCourse.imageHugsTitle = YES;
    _themeButton = [NSButton buttonWithTitle:@"" target:self action:@selector(showAppearanceMenu:)];
    _themeButton.image = [NSImage imageWithSystemSymbolName:@"circle.lefthalf.filled" accessibilityDescription:nil];
    _themeButton.imagePosition = NSImageOnly;
    _themeButton.toolTip = @"外观";
    [_themeButton setAccessibilityLabel:@"外观"];
    NSView *addCourseSurface = HBButtonSurface(_addCourse);
    NSView *themeSurface = HBButtonSurface(_themeButton);
    for (NSView *view in @[_semesters, scroll, addCourseSurface, themeSurface]) {
        view.translatesAutoresizingMaskIntoConstraints = NO;
        [sideView addSubview:view];
    }
    [NSLayoutConstraint activateConstraints:@[
        [_semesters.topAnchor constraintEqualToAnchor:sideView.safeAreaLayoutGuide.topAnchor constant:12],
        [_semesters.leadingAnchor constraintEqualToAnchor:sideView.leadingAnchor constant:12],
        [_semesters.trailingAnchor constraintEqualToAnchor:sideView.trailingAnchor constant:-12],
        [scroll.topAnchor constraintEqualToAnchor:_semesters.bottomAnchor constant:12],
        [scroll.leadingAnchor constraintEqualToAnchor:sideView.leadingAnchor constant:6],
        [scroll.trailingAnchor constraintEqualToAnchor:sideView.trailingAnchor constant:-6],
        [scroll.bottomAnchor constraintEqualToAnchor:addCourseSurface.topAnchor constant:-12],
        [addCourseSurface.leadingAnchor constraintEqualToAnchor:sideView.leadingAnchor constant:12],
        [addCourseSurface.trailingAnchor constraintEqualToAnchor:themeSurface.leadingAnchor constant:-8],
        [addCourseSurface.bottomAnchor constraintEqualToAnchor:themeSurface.bottomAnchor],
        [addCourseSurface.heightAnchor constraintEqualToAnchor:themeSurface.heightAnchor],
        [themeSurface.trailingAnchor constraintEqualToAnchor:sideView.trailingAnchor constant:-12],
        [themeSurface.bottomAnchor constraintEqualToAnchor:sideView.safeAreaLayoutGuide.bottomAnchor constant:-12],
        [themeSurface.widthAnchor constraintEqualToConstant:36],
        [themeSurface.heightAnchor constraintEqualToAnchor:themeSurface.widthAnchor]
    ]];
    NSToolbar *toolbar = [[NSToolbar alloc] initWithIdentifier:@"homeworkbook.toolbar"];
    toolbar.delegate = self;
    toolbar.displayMode = NSToolbarDisplayModeIconOnly;
    toolbar.allowsUserCustomization = NO;
    window.toolbar = toolbar;
    window.toolbarStyle = NSWindowToolbarStyleUnified;
    // Installing the split controller expands the frame to make room for the
    // sidebar. Keep the original outer frame and fit both panes inside it.
    window.minSize = minimum;
    [window setFrame:frame display:YES];
    [window makeFirstResponder:webview];
    [self installStatusMenu];
    [self installApplicationMenus];
    return self;
}
- (NSMenuItem *)menuItem:(NSString *)title action:(SEL)action {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:action keyEquivalent:@""];
    item.target = self;
    return item;
}
- (void)installStatusMenu {
    self.statusItem = [NSStatusBar.systemStatusBar statusItemWithLength:NSVariableStatusItemLength];
    NSStatusBarButton *button = self.statusItem.button;
    button.image = [NSImage imageWithSystemSymbolName:@"checklist" accessibilityDescription:@"作业簿"];
    button.image.template = YES;
    button.toolTip = @"作业簿";
    if (!button.image) button.title = @"作业簿";

    NSMenu *menu = [NSMenu new];
    [menu addItem:[self menuItem:@"显示作业簿" action:@selector(showMainWindow:)]];
    [menu addItem:NSMenuItem.separatorItem];
    for (NSArray<NSString *> *destination in @[@[@"待办", @"overview"], @[@"作业", @"all"], @[@"文件", @"files"]]) {
        NSMenuItem *item = [self menuItem:destination[0] action:@selector(navigateFromMenu:)];
        item.representedObject = destination[1];
        [menu addItem:item];
    }
    [menu addItem:NSMenuItem.separatorItem];
    [menu addItem:[self menuItem:@"新建作业…" action:@selector(quickAddAssignment:)]];
    [menu addItem:[self menuItem:@"查找作业…" action:@selector(findAssignments:)]];
    [menu addItem:[self menuItem:@"设置…" action:@selector(openSettings:)]];
    [menu addItem:NSMenuItem.separatorItem];
    [menu addItem:[self menuItem:@"隐藏窗口" action:@selector(hideMainWindow:)]];
    NSMenuItem *quit = [[NSMenuItem alloc] initWithTitle:@"退出作业簿" action:@selector(terminate:) keyEquivalent:@""];
    quit.target = NSApp;
    [menu addItem:quit];
    self.statusItem.menu = menu;

    self.statusItem.visible = ![NSUserDefaults.standardUserDefaults boolForKey:@"HideHomeworkbookStatusItem"];
}
- (NSMenuItem *)menuItem:(NSString *)title action:(SEL)action key:(NSString *)key {
    NSMenuItem *item = [self menuItem:title action:action];
    item.keyEquivalent = key;
    item.keyEquivalentModifierMask = NSEventModifierFlagCommand;
    return item;
}
- (void)installApplicationMenus {
    NSMenu *mainMenu = NSApp.mainMenu;
    NSMenu *appMenu = mainMenu.itemArray.firstObject.submenu;
    if (!appMenu) return;

    NSMenuItem *settings = [self menuItem:@"设置…" action:@selector(openSettings:) key:@","];
    NSMenuItem *status = [self menuItem:@"在菜单栏显示作业簿" action:@selector(toggleStatusItem:)];
    status.state = self.statusItem.visible ? NSControlStateValueOn : NSControlStateValueOff;
    NSInteger firstCommand = MIN(1, appMenu.numberOfItems);
    [appMenu insertItem:settings atIndex:firstCommand];
    [appMenu insertItem:status atIndex:firstCommand + 1];

    NSDictionary *titles = @{@"File":@"文件", @"Edit":@"编辑", @"View":@"显示", @"Window":@"窗口", @"Help":@"帮助"};
    for (NSMenuItem *topItem in mainMenu.itemArray) {
        NSString *originalTitle = topItem.title;
        NSMenu *menu = topItem.submenu;
        if (!menu || !titles[originalTitle]) continue;
        topItem.title = titles[originalTitle];
        menu.title = topItem.title;
        if ([originalTitle isEqualToString:@"File"]) {
            NSMenuItem *assignment = [self menuItem:@"新建作业…" action:@selector(quickAddAssignment:) key:@"n"];
            NSMenuItem *course = [self menuItem:@"添加课程…" action:@selector(addCourseFromMenu:) key:@"n"];
            course.keyEquivalentModifierMask |= NSEventModifierFlagShift;
            [menu insertItem:assignment atIndex:0];
            [menu insertItem:course atIndex:1];
            [menu insertItem:NSMenuItem.separatorItem atIndex:2];
        } else if ([originalTitle isEqualToString:@"Edit"]) {
            [menu addItem:NSMenuItem.separatorItem];
            [menu addItem:[self menuItem:@"查找作业…" action:@selector(findAssignments:) key:@"f"]];
        } else if ([originalTitle isEqualToString:@"View"]) {
            NSArray<NSArray<NSString *> *> *destinations = @[
                @[@"待办", @"overview", @"1"], @[@"作业", @"all", @"2"],
                @[@"文件", @"files", @"3"], @[@"周期计划", @"plans", @"4"],
            ];
            for (NSArray<NSString *> *destination in destinations.reverseObjectEnumerator) {
                NSMenuItem *item = [self menuItem:destination[0] action:@selector(navigateFromMenu:) key:destination[2]];
                item.representedObject = destination[1];
                [menu insertItem:item atIndex:0];
            }
            [menu insertItem:NSMenuItem.separatorItem atIndex:destinations.count];
            NSMenuItem *sidebar = [self menuItem:@"隐藏侧边栏" action:@selector(toggleSidebarFromMenu:) key:@"s"];
            sidebar.keyEquivalentModifierMask |= NSEventModifierFlagControl;
            [menu insertItem:sidebar atIndex:destinations.count + 1];

            NSMenuItem *appearance = [self menuItem:@"外观" action:nil];
            appearance.submenu = [self appearanceMenu];
            [menu insertItem:appearance atIndex:destinations.count + 2];
            [menu insertItem:NSMenuItem.separatorItem atIndex:destinations.count + 3];
        } else if ([originalTitle isEqualToString:@"Window"]) {
            [menu insertItem:[self menuItem:@"显示作业簿" action:@selector(showMainWindow:)] atIndex:0];
            [menu insertItem:NSMenuItem.separatorItem atIndex:1];
        }
    }
}
- (BOOL)validateMenuItem:(NSMenuItem *)item {
    SEL action = item.action;
    if (action == @selector(quickAddAssignment:)) return !self.blocked && self.canAdd;
    if (action == @selector(addCourseFromMenu:)) return !self.blocked && self.semesterData.count > 0;
    if (action == @selector(navigateFromMenu:)) {
        NSString *destination = item.representedObject;
        BOOL matchingCourseView = [destination isEqual:@"all"] && [self.activeView isEqual:@"course"];
        item.state = [destination isEqual:self.activeView] || matchingCourseView ? NSControlStateValueOn : NSControlStateValueOff;
        return !self.blocked && (![destination isEqual:@"plans"] || self.showPlans);
    }
    if (action == @selector(selectThemeFromMenu:)) {
        item.state = [item.representedObject isEqual:self.theme] ? NSControlStateValueOn : NSControlStateValueOff;
        return !self.blocked;
    }
    if (action == @selector(toggleSidebarFromMenu:)) {
        item.title = self.split.splitViewItems.firstObject.isCollapsed ? @"显示侧边栏" : @"隐藏侧边栏";
        return !self.blocked;
    }
    if (action == @selector(openSettings:) || action == @selector(findAssignments:)) return !self.blocked;
    if (action == @selector(hideMainWindow:)) return self.window.isVisible && !self.window.isMiniaturized;
    if (action == @selector(editCourseFromMenu:)) return !self.blocked;
    return YES;
}
- (void)navigateFromMenu:(NSMenuItem *)item {
    [self showMainWindow:item];
    [self send:@"view" value:item.representedObject];
}
- (void)selectThemeFromMenu:(NSMenuItem *)item {
    [self send:@"set-theme" value:item.representedObject];
}
- (void)toggleSidebarFromMenu:(NSMenuItem *)item {
    if (self.blocked) return;
    [self showMainWindow:item];
    [self.split toggleSidebar:item];
}
- (void)addCourseFromMenu:(NSMenuItem *)item {
    [self showMainWindow:item];
    [self send:@"add-course" value:@""];
}
- (void)findAssignments:(NSMenuItem *)item {
    if (self.blocked) return;
    [self showMainWindow:item];
    if (self.showSearch) {
        [self.searchItem beginSearchInteraction];
    } else {
        self.pendingSearchFocus = YES;
        [self send:@"view" value:@"all"];
    }
}
- (void)toggleStatusItem:(NSMenuItem *)item {
    self.statusItem.visible = !self.statusItem.visible;
    item.state = self.statusItem.visible ? NSControlStateValueOn : NSControlStateValueOff;
    [NSUserDefaults.standardUserDefaults setBool:!self.statusItem.visible forKey:@"HideHomeworkbookStatusItem"];
}
- (void)showMainWindow:(id)sender {
    (void)sender;
    if (self.window.miniaturized) [self.window deminiaturize:nil];
    [self.window makeKeyAndOrderFront:nil];
    if (@available(macOS 14.0, *)) [NSApp activate];
    else [NSApp activateIgnoringOtherApps:YES];
}
- (void)hideMainWindow:(id)sender { (void)sender; [self.window orderOut:nil]; }
- (void)quickAddAssignment:(id)sender {
    [self showMainWindow:sender];
    [self send:@"quick-add-assignment" value:@""];
}
- (void)openSettings:(id)sender {
    [self showMainWindow:sender];
    [self send:@"view" value:@"settings"];
}
- (NSArray<NSToolbarItemIdentifier> *)toolbarAllowedItemIdentifiers:(NSToolbar *)toolbar {
    return [[self toolbarDefaultItemIdentifiers:toolbar] arrayByAddingObjectsFromArray:@[HBFilter, HBTools, HBAdd, HBSearch]];
}
- (NSArray<NSToolbarItemIdentifier> *)toolbarDefaultItemIdentifiers:(NSToolbar *)toolbar {
    (void)toolbar;
    return @[NSToolbarToggleSidebarItemIdentifier, NSToolbarSidebarTrackingSeparatorItemIdentifier, NSToolbarFlexibleSpaceItemIdentifier];
}
- (NSToolbarItem *)toolbar:(NSToolbar *)toolbar itemForItemIdentifier:(NSToolbarItemIdentifier)identifier willBeInsertedIntoToolbar:(BOOL)flag {
    (void)toolbar; (void)flag;
    if ([identifier isEqualToString:HBSearch]) {
        if (self.searchItem) return self.searchItem;
        NSSearchToolbarItem *item = [[NSSearchToolbarItem alloc] initWithItemIdentifier:identifier];
        item.label = @"搜索作业";
        item.paletteLabel = item.label;
        item.searchField.placeholderString = @"搜索作业";
        [item.searchField setAccessibilityLabel:@"搜索作业"];
        item.searchField.delegate = self;
        item.searchField.target = self;
        item.searchField.action = @selector(sendSearch:);
        item.autovalidates = NO;
        item.visibilityPriority = NSToolbarItemVisibilityPriorityHigh;
        self.searchItem = item;
        return item;
    }
    if ([identifier isEqualToString:HBFilter] || [identifier isEqualToString:HBTools]) {
        BOOL filter = [identifier isEqualToString:HBFilter];
        NSMenuToolbarItem *existing = filter ? self.filterItem : self.toolsItem;
        if (existing) return existing;
        NSMenuToolbarItem *item = [[NSMenuToolbarItem alloc] initWithItemIdentifier:identifier];
        item.label = filter ? @"筛选作业状态" : @"作业工具";
        item.paletteLabel = item.label;
        item.toolTip = item.label;
        item.image = [NSImage imageWithSystemSymbolName:filter ? @"line.3.horizontal.decrease" : @"ellipsis"
                           accessibilityDescription:item.label];
        item.bordered = YES;
        item.autovalidates = NO;
        if (!filter) item.visibilityPriority = NSToolbarItemVisibilityPriorityLow;
        if (filter) self.filterItem = item;
        else self.toolsItem = item;
        return item;
    }
    if ([identifier isEqualToString:HBAdd]) {
        if (self.addItem) return self.addItem;
        NSToolbarItem *item = [[NSToolbarItem alloc] initWithItemIdentifier:identifier];
        item.label = @"新建作业";
        item.paletteLabel = item.label;
        item.toolTip = item.label;
        item.image = [NSImage imageWithSystemSymbolName:@"plus" accessibilityDescription:item.label];
        item.bordered = YES;
        item.target = self;
        item.action = @selector(addAssignmentAction:);
        item.autovalidates = NO;
        self.addItem = item;
        return item;
    }
    return nil;
}
- (NSMenu *)courseMenuForRow:(NSInteger)row {
    if (self.blocked || row < 0 || (NSUInteger)row >= self.rows.count) return nil;
    NSDictionary *course = self.rows[(NSUInteger)row];
    if (![course[@"action"] isEqual:@"course"]) return nil;
    NSMenu *menu = [NSMenu new];
    NSMenuItem *edit = [self menuItem:@"编辑课程…" action:@selector(editCourseFromMenu:)];
    edit.representedObject = course[@"value"];
    edit.image = [NSImage imageWithSystemSymbolName:@"pencil" accessibilityDescription:nil];
    [menu addItem:edit];
    return menu;
}
- (void)editCourseFromMenu:(NSMenuItem *)item {
    [self send:@"edit-course" value:item.representedObject];
}
- (NSInteger)numberOfRowsInTableView:(NSTableView *)tableView { (void)tableView; return (NSInteger)self.rows.count; }
- (BOOL)tableView:(NSTableView *)tableView isGroupRow:(NSInteger)row {
    (void)tableView;
    return [self.rows[(NSUInteger)row][@"action"] length] == 0;
}
- (BOOL)tableView:(NSTableView *)tableView shouldSelectRow:(NSInteger)row {
    return !self.blocked && ![self tableView:tableView isGroupRow:row];
}
- (NSView *)tableView:(NSTableView *)tableView viewForTableColumn:(NSTableColumn *)column row:(NSInteger)row {
    (void)column;
    NSDictionary *item = self.rows[(NSUInteger)row];
    BOOL heading = [self tableView:tableView isGroupRow:row];
    NSString *reuseID = heading ? @"heading" : @"navigationRow";
    NSTableCellView *cell = [tableView makeViewWithIdentifier:reuseID owner:self];
    if (!cell) {
        cell = [[NSTableCellView alloc] initWithFrame:NSZeroRect];
        cell.identifier = reuseID;
        NSTextField *label = [NSTextField labelWithString:@""];
        label.translatesAutoresizingMaskIntoConstraints = NO;
        label.lineBreakMode = NSLineBreakByTruncatingTail;
        [cell addSubview:label];
        cell.textField = label;
        if (heading) {
            label.font = [NSFont systemFontOfSize:12 weight:NSFontWeightSemibold];
            label.textColor = NSColor.secondaryLabelColor;
        } else {
            label.font = [NSFont systemFontOfSize:14];
        }
        NSLayoutXAxisAnchor *leading = cell.leadingAnchor;
        if (!heading) {
            NSImageView *icon = [[NSImageView alloc] initWithFrame:NSZeroRect];
            icon.translatesAutoresizingMaskIntoConstraints = NO;
            icon.imageScaling = NSImageScaleProportionallyDown;
            [icon setAccessibilityElement:NO];
            [cell addSubview:icon];
            cell.imageView = icon;
            [NSLayoutConstraint activateConstraints:@[
                [icon.leadingAnchor constraintEqualToAnchor:cell.leadingAnchor],
                [icon.centerYAnchor constraintEqualToAnchor:cell.centerYAnchor],
                [icon.widthAnchor constraintEqualToConstant:18],
                [icon.heightAnchor constraintEqualToConstant:18]
            ]];
            leading = icon.trailingAnchor;
        }
        [NSLayoutConstraint activateConstraints:@[
            [label.leadingAnchor constraintEqualToAnchor:leading constant:heading ? 0 : 8],
            [label.trailingAnchor constraintEqualToAnchor:cell.trailingAnchor constant:-4],
            [label.centerYAnchor constraintEqualToAnchor:cell.centerYAnchor]
        ]];
    }
    cell.textField.stringValue = item[@"name"];
    cell.toolTip = [item[@"action"] isEqual:@"course"] ? item[@"name"] : nil;
    if (!heading) cell.imageView.image = [NSImage imageWithSystemSymbolName:item[@"symbol"] accessibilityDescription:nil];
    return cell;
}
- (void)tableViewSelectionDidChange:(NSNotification *)notification {
    (void)notification;
    NSInteger row = self.table.selectedRow;
    if (row < 0 || (NSUInteger)row >= self.rows.count) return;
    NSDictionary *item = self.rows[(NSUInteger)row];
    [self send:item[@"action"] value:item[@"value"]];
}
- (void)selectSemester:(NSMenuItem *)item {
    [self send:@"semester" value:item.representedObject];
}
- (void)addCourseAction:(id)sender { (void)sender; [self send:@"add-course" value:@""]; }
- (void)addAssignmentAction:(id)sender { (void)sender; [self send:@"add-assignment" value:@""]; }
- (NSMenu *)appearanceMenu {
    return [self menuWithChoices:@[
        @{@"id": @"system", @"name": @"跟随系统"},
        @{@"id": @"light", @"name": @"浅色"},
        @{@"id": @"dark", @"name": @"深色"},
    ] action:@selector(selectThemeFromMenu:) selected:self.theme];
}
- (void)showAppearanceMenu:(NSButton *)sender {
    if (self.blocked) return;
    NSRect bounds = sender.bounds;
    NSPoint origin = NSMakePoint(NSMinX(bounds), sender.isFlipped ? NSMaxY(bounds) : NSMinY(bounds));
    [[self appearanceMenu] popUpMenuPositioningItem:nil atLocation:origin inView:sender];
}
- (void)sendSearch:(NSSearchField *)field {
    NSText *editor = field.currentEditor;
    if ([editor isKindOfClass:NSTextView.class] && [(NSTextView *)editor hasMarkedText]) return;
    if (self.showSearch) [self send:@"search" value:field.stringValue];
}
- (void)controlTextDidChange:(NSNotification *)notification {
    if (notification.object == self.searchItem.searchField) [self sendSearch:self.searchItem.searchField];
}
- (NSMenu *)menuWithChoices:(NSArray<NSDictionary *> *)choices action:(SEL)action selected:(NSString *)selected {
    NSMenu *menu = [NSMenu new];
    for (NSDictionary *choice in choices) {
        NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:choice[@"name"] action:action keyEquivalent:@""];
        item.target = self;
        item.representedObject = choice[@"id"];
        item.state = [item.representedObject isEqual:selected] ? NSControlStateValueOn : NSControlStateValueOff;
        [menu addItem:item];
    }
    return menu;
}
- (void)selectFilter:(NSMenuItem *)item { [self send:@"filter" value:item.representedObject]; }
- (void)selectTool:(NSMenuItem *)item { [self send:@"tool" value:item.representedObject]; }

- (void)applyTheme:(NSString *)theme {
    if ([theme isEqualToString:self.theme]) return;
    self.theme = theme;
    NSAppearance *appearance = nil;
    if ([theme isEqualToString:@"dark"]) appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    else if ([theme isEqualToString:@"light"]) appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
    // The title bar and standard menus use the application's appearance.
    // Reset the window fill to AppKit's semantic background for that appearance.
    NSApp.appearance = appearance;
    self.window.appearance = nil;
    self.window.backgroundColor = nil;
}
- (void)apply:(NSDictionary *)state {
    [self applyTheme:state[@"theme"]];
    self.blocked = [state[@"blocked"] boolValue];
    self.showSearch = [state[@"showSearch"] boolValue];
    self.showAdd = [state[@"showAddAssignment"] boolValue];
    self.canAdd = [state[@"canAddAssignment"] boolValue];
    self.showPlans = [state[@"showPlans"] boolValue];
    self.activeView = state[@"view"];
    NSArray *semesters = state[@"semesters"];
    if (![self.semesterData isEqualToArray:semesters]) {
        self.semesterData = semesters;
        [self.semesters removeAllItems];
        for (NSDictionary *semester in semesters) {
            NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:semester[@"name"] action:@selector(selectSemester:) keyEquivalent:@""];
            item.target = self;
            item.representedObject = semester[@"id"];
            [self.semesters.menu addItem:item];
        }
    }
    NSInteger chosenSemester = [self.semesters indexOfItemWithRepresentedObject:state[@"semesterId"]];
    if (chosenSemester < 0) [self.semesters selectItem:nil];
    else if (chosenSemester != self.semesters.indexOfSelectedItem) [self.semesters selectItemAtIndex:chosenSemester];

    NSMutableArray *rows = [NSMutableArray arrayWithArray:@[
        HBRow(@"待办", @"view", @"overview", @"checklist"),
        HBRow(@"作业", @"view", @"all", @"doc.text")
    ]];
    if (self.showPlans) [rows addObject:HBRow(@"周期计划", @"view", @"plans", @"repeat")];
    [rows addObject:HBRow(@"文件", @"view", @"files", @"folder")];
    [rows addObject:HBRow(@"设置", @"view", @"settings", @"gearshape")];
    [rows addObject:HBRow(@"我的课程", @"", @"", @"")];
    for (NSDictionary *course in state[@"courses"]) [rows addObject:HBRow(course[@"name"], @"course", course[@"id"], @"book")];

    BOOL rowsChanged = ![self.rows isEqualToArray:rows];
    NSInteger selected = -1;
    NSString *view = state[@"view"];
    NSString *selectedAction = [view isEqualToString:@"course"] ? @"course" : @"view";
    NSString *selectedValue = [view isEqualToString:@"course"] ? state[@"courseId"] : view;
    for (NSUInteger index = 0; index < rows.count; index++) {
        NSDictionary *row = rows[index];
        if ([row[@"action"] isEqualToString:selectedAction] && [row[@"value"] isEqualToString:selectedValue]) {
            selected = (NSInteger)index;
            break;
        }
    }
    if (rowsChanged || selected != self.table.selectedRow) {
        // Programmatic selection must not trigger navigation callbacks.
        self.table.delegate = nil;
        if (rowsChanged) {
            self.rows = rows;
            [self.table reloadData];
        }
        if (selected >= 0) {
            [self.table selectRowIndexes:[NSIndexSet indexSetWithIndex:(NSUInteger)selected] byExtendingSelection:NO];
            [self.table scrollRowToVisible:selected];
        } else [self.table deselectAll:nil];
        self.table.delegate = self;
    }
    self.table.enabled = !self.blocked;
    self.semesters.enabled = !self.blocked && self.semesterData.count > 0;
    self.addCourse.enabled = !self.blocked && self.semesterData.count > 0;
    self.themeButton.enabled = !self.blocked;
    NSDictionary *filter = [state[@"assignmentFilter"] isKindOfClass:NSDictionary.class] ? state[@"assignmentFilter"] : nil;
    NSArray *tools = state[@"tools"];
    NSMutableArray<NSString *> *visible = [NSMutableArray array];
    if (filter) [visible addObject:HBFilter];
    if (tools.count) [visible addObject:HBTools];
    if (self.showAdd) [visible addObject:HBAdd];
    if (self.showSearch) [visible addObject:HBSearch];

    // Keep search as the last item and avoid replacing a field the user is editing.
    NSToolbar *toolbar = self.window.toolbar;
    NSArray *optional = @[HBFilter, HBTools, HBAdd, HBSearch];
    for (NSInteger index = (NSInteger)toolbar.items.count - 1; index >= 0; index--) {
        NSToolbarItem *item = toolbar.items[(NSUInteger)index];
        NSString *identifier = item.itemIdentifier;
        if ([optional containsObject:identifier] && ![visible containsObject:identifier]) {
            [toolbar removeItemAtIndex:index];
        } else if ([identifier isEqualToString:NSToolbarToggleSidebarItemIdentifier]) {
            item.autovalidates = NO;
            item.enabled = !self.blocked;
        }
    }
    NSUInteger insertionIndex = [self toolbarDefaultItemIdentifiers:toolbar].count;
    for (NSString *identifier in visible) {
        if (insertionIndex >= toolbar.items.count || ![toolbar.items[insertionIndex].itemIdentifier isEqualToString:identifier]) {
            [toolbar insertItemWithItemIdentifier:identifier atIndex:insertionIndex];
        }
        insertionIndex++;
    }
    if (filter && ![self.assignmentFilter isEqualToDictionary:filter]) {
        self.filterItem.menu = [self menuWithChoices:filter[@"options"] action:@selector(selectFilter:) selected:filter[@"selected"]];
        NSString *selected = filter[@"selected"];
        NSString *label = @"筛选作业状态";
        for (NSDictionary *option in filter[@"options"]) {
            if ([option[@"id"] isEqual:selected]) {
                label = [NSString stringWithFormat:@"筛选作业状态（%@）", option[@"name"]];
                break;
            }
        }
        BOOL narrowed = ![selected isEqual:@"all"];
        self.filterItem.image = [NSImage imageWithSystemSymbolName:narrowed ? @"line.3.horizontal.decrease.circle.fill" : @"line.3.horizontal.decrease"
                                         accessibilityDescription:label];
        self.filterItem.toolTip = label;
        self.assignmentFilter = filter;
    }
    if (tools.count && ![self.tools isEqualToArray:tools]) {
        self.toolsItem.menu = [self menuWithChoices:tools action:@selector(selectTool:) selected:nil];
        self.tools = tools;
    }
    self.filterItem.enabled = !self.blocked;
    self.toolsItem.enabled = !self.blocked;
    self.searchItem.enabled = !self.blocked && self.showSearch;
    self.searchItem.searchField.enabled = self.searchItem.enabled;
    self.addItem.enabled = !self.blocked && self.showAdd && self.canAdd;
    NSNumber *reset = [state[@"searchReset"] isKindOfClass:NSNumber.class] ? state[@"searchReset"] : @0;
    if (self.lastReset && ![self.lastReset isEqualToNumber:reset]) {
        [self.searchItem.searchField abortEditing];
        self.searchItem.searchField.stringValue = @"";
    }
    self.lastReset = reset;
    if (self.pendingSearchFocus && self.searchItem.enabled) {
        self.pendingSearchFocus = NO;
        [self.searchItem beginSearchInteraction];
    }
}
@end

bool homeworkbook_update_macos_chrome(void *windowPointer, void *webviewPointer, const char *json) {
    if (![NSThread isMainThread] || !windowPointer || !webviewPointer || !json) return false;
    NSWindow *window = (__bridge NSWindow *)windowPointer;
    WKWebView *webview = (__bridge WKWebView *)webviewPointer;
    NSData *data = [NSData dataWithBytes:json length:strlen(json)];
    id state = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![state isKindOfClass:NSDictionary.class]) return false;
    static char associationKey;
    HBChrome *chrome = objc_getAssociatedObject(window, &associationKey);
    if (!chrome) {
        chrome = [[HBChrome alloc] initWithWindow:window webview:webview];
        if (!chrome) return false;
        objc_setAssociatedObject(window, &associationKey, chrome, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    [chrome apply:state];
    return true;
}

// A transparent sibling of the webview only claims hits on actual controls.
@interface HBContentHost : NSView
@property(nonatomic, weak) WKWebView *webview;
@end
@implementation HBContentHost
- (BOOL)isFlipped { return YES; }
- (NSView *)hitTest:(NSPoint)point {
    NSView *hit = [super hitTest:point];
    return hit == self ? nil : hit;
}
- (void)scrollWheel:(NSEvent *)event { [self.webview scrollWheel:event]; }
@end

@interface HBContentControls : NSObject
@property(nonatomic, weak) WKWebView *webview;
@property(nonatomic, strong) HBContentHost *host;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSControl *> *controls;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSView *> *surfaces;
- (instancetype)initWithWebview:(WKWebView *)webview;
- (BOOL)apply:(NSArray *)items;
@end
static char HBControlContextKey;

static void HBApplyTint(NSButton *button, NSView *surface, NSString *tint) {
    BOOL destructive = [tint isEqual:@"destructive"];
    if (@available(macOS 26.0, *)) {
        if (![surface isKindOfClass:NSGlassEffectView.class]) return;
        NSGlassEffectView *glass = (NSGlassEffectView *)surface;
        NSColor *color = destructive ? NSColor.systemRedColor : [tint isEqual:@"accent"] ? NSColor.controlAccentColor : nil;
        color = button.enabled ? [color colorWithAlphaComponent:destructive ? 0.24 : 0.25] : nil;
        if (glass.tintColor != color && ![glass.tintColor isEqual:color]) glass.tintColor = color;
    } else {
        button.contentTintColor = destructive && button.enabled ? NSColor.systemRedColor : nil;
    }
}

@implementation HBContentControls
- (instancetype)initWithWebview:(WKWebView *)webview {
    self = [super init];
    if (!self || !webview.superview) return nil;
    _webview = webview;
    _controls = [NSMutableDictionary dictionary];
    _surfaces = [NSMutableDictionary dictionary];
    _host = [HBContentHost new];
    _host.webview = webview;
    _host.clipsToBounds = YES;
    _host.translatesAutoresizingMaskIntoConstraints = NO;
    [webview.superview addSubview:_host positioned:NSWindowAbove relativeTo:webview];
    // WebKit's CSS viewport excludes the unified toolbar. Use the same safe
    // area for AppKit so DOM coordinates also work in full-screen mode.
    NSLayoutGuide *viewport = webview.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [_host.leadingAnchor constraintEqualToAnchor:viewport.leadingAnchor],
        [_host.trailingAnchor constraintEqualToAnchor:viewport.trailingAnchor],
        [_host.topAnchor constraintEqualToAnchor:viewport.topAnchor],
        [_host.bottomAnchor constraintEqualToAnchor:viewport.bottomAnchor],
    ]];
    return self;
}
- (void)activate:(NSControl *)control {
    NSString *value = @"";
    if ([control isKindOfClass:NSSegmentedControl.class]) value = [NSString stringWithFormat:@"%ld", (long)((NSSegmentedControl *)control).selectedSegment];
    if ([control isKindOfClass:NSPopUpButton.class]) value = ((NSPopUpButton *)control).selectedItem.representedObject ?: @"";
    [self sendControl:control value:value];
}
- (void)activateMenuChoice:(NSMenuItem *)item {
    for (NSControl *control in self.controls.allValues) {
        if ([control isKindOfClass:NSPopUpButton.class] && [(NSPopUpButton *)control menu] == item.menu) {
            [self sendControl:control value:item.representedObject];
            break;
        }
    }
}
- (void)sendControl:(NSControl *)control value:(NSString *)value {
    NSArray *parts = @[control.identifier ?: @"", value ?: @""];
    NSMutableDictionary *detail = [@{ @"action": @"content", @"value": [parts componentsJoinedByString:@":"] } mutableCopy];
    detail[@"context"] = objc_getAssociatedObject(control, &HBControlContextKey);
    NSData *data = [NSJSONSerialization dataWithJSONObject:detail options:0 error:nil];
    if (!data) return;
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    [self.webview evaluateJavaScript:[NSString stringWithFormat:@"window.dispatchEvent(new CustomEvent('homeworkbook:macos-chrome-action',{detail:%@}))", json] completionHandler:nil];
}
- (BOOL)apply:(NSArray *)items {
    if (!self.webview.superview || self.host.superview != self.webview.superview) return NO;
    NSMutableSet *remaining = [NSMutableSet setWithArray:self.controls.allKeys];
    for (NSDictionary *item in items) {
        if (![item isKindOfClass:NSDictionary.class] || ![item[@"id"] isKindOfClass:NSString.class] || ![item[@"kind"] isKindOfClass:NSString.class]) continue;
        NSString *identifier = item[@"id"];
        NSString *kind = item[@"kind"];
        NSControl *control = self.controls[identifier];
        if (!control) {
            if ([kind isEqualToString:@"segments"]) {
                NSSegmentedControl *segments = [[NSSegmentedControl alloc] initWithFrame:NSZeroRect];
                segments.segmentStyle = NSSegmentStyleCapsule;
                segments.trackingMode = NSSegmentSwitchTrackingSelectOne;
                segments.controlSize = NSControlSizeLarge;
                segments.segmentDistribution = NSSegmentDistributionFillEqually;
                control = segments;
            }
            else if ([kind isEqualToString:@"select"] || [kind isEqualToString:@"menu"]) {
                BOOL pullsDown = [kind isEqualToString:@"menu"];
                NSPopUpButton *popup = [[NSPopUpButton alloc] initWithFrame:NSZeroRect pullsDown:pullsDown];
                if (pullsDown) {
                    popup.cell = [[HBCenteredPullDownCell alloc] initTextCell:@"" pullsDown:YES];
                    popup.alignment = NSTextAlignmentCenter;
                }
                popup.controlSize = NSControlSizeLarge;
                control = popup;
            }
            else if ([kind isEqualToString:@"button"]) control = [NSButton buttonWithTitle:@"" target:self action:@selector(activate:)];
            if (!control) continue;
            control.identifier = identifier;
            control.target = self;
            BOOL menu = [kind isEqualToString:@"menu"];
            control.action = menu ? nil : @selector(activate:);
            NSView *surface = menu || [kind isEqualToString:@"button"] ? HBButtonSurface((NSButton *)control) : control;
            if ([kind isEqualToString:@"select"] && [item[@"opaque"] boolValue]) {
                surface = [HBOpaquePopupSurface new];
                surface.autoresizesSubviews = YES;
                control.frame = surface.bounds;
                control.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
                [surface addSubview:control];
            }
            [self.host addSubview:surface];
            self.controls[identifier] = control;
            self.surfaces[identifier] = surface;
        }
        [remaining removeObject:identifier];
        objc_setAssociatedObject(control, &HBControlContextKey, item[@"context"], OBJC_ASSOCIATION_COPY_NONATOMIC);
        NSView *surface = self.surfaces[identifier];
        NSRect frame = NSMakeRect([item[@"x"] doubleValue], [item[@"y"] doubleValue], [item[@"width"] doubleValue], [item[@"height"] doubleValue]);
        if (!NSEqualRects(surface.frame, frame)) surface.frame = frame;
        BOOL enabled = ![item[@"disabled"] boolValue];
        if (control.enabled != enabled) control.enabled = enabled;
        NSString *label = [item[@"label"] isKindOfClass:NSString.class] ? item[@"label"] : @"";
        if (![control.accessibilityLabel isEqualToString:label]) [control setAccessibilityLabel:label];
        NSArray *options = [item[@"options"] isKindOfClass:NSArray.class] ? item[@"options"] : @[];
        NSString *selected = [item[@"selected"] isKindOfClass:NSString.class] ? item[@"selected"] : @"";
        if ([control isKindOfClass:NSSegmentedControl.class]) {
            NSSegmentedControl *segments = (NSSegmentedControl *)control;
            if (segments.segmentCount != (NSInteger)options.count) segments.segmentCount = (NSInteger)options.count;
            for (NSUInteger i = 0; i < options.count; i++) {
                NSString *name = options[i][@"name"];
                if (![[segments labelForSegment:(NSInteger)i] isEqualToString:name]) [segments setLabel:name forSegment:(NSInteger)i];
            }
            if (segments.selectedSegment != selected.integerValue) segments.selectedSegment = selected.integerValue;
        } else if ([control isKindOfClass:NSPopUpButton.class]) {
            NSPopUpButton *popup = (NSPopUpButton *)control;
            static char optionsKey;
            NSArray *previousOptions = objc_getAssociatedObject(popup, &optionsKey);
            if (![previousOptions isEqualToArray:options]) {
                [popup removeAllItems];
                for (NSDictionary *option in options) {
                    [popup addItemWithTitle:option[@"name"]];
                    NSMenuItem *choice = popup.lastItem;
                    choice.representedObject = option[@"id"];
                    if (popup.pullsDown && [option[@"id"] length]) {
                        choice.target = self;
                        choice.action = @selector(activateMenuChoice:);
                        NSString *identifier = option[@"id"];
                        NSString *symbol = [identifier isEqual:@"delete"] ? @"trash" : [identifier isEqual:@"edit"] ? @"pencil" : @"plus";
                        choice.image = [NSImage imageWithSystemSymbolName:symbol accessibilityDescription:nil];
                    }
                }
                objc_setAssociatedObject(popup, &optionsKey, [options copy], OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            }
            if (popup.pullsDown) HBApplyTint(popup, surface, item[@"tint"]);
            else {
                NSInteger selectedIndex = [popup indexOfItemWithRepresentedObject:selected];
                if (selectedIndex >= 0 && selectedIndex != popup.indexOfSelectedItem) [popup selectItemAtIndex:selectedIndex];
            }
        } else if ([control isKindOfClass:NSButton.class]) {
            NSButton *button = (NSButton *)control;
            if (![button.title isEqualToString:label]) button.title = label;
            if ([selected isEqual:@"true"] || [selected isEqual:@"false"]) {
                [button setAccessibilityValue:@([selected isEqual:@"true"])];
            }
            NSString *symbol = [item[@"symbol"] isKindOfClass:NSString.class] ? item[@"symbol"] : nil;
            // A geometry update should not replace the image object on every pass.
            static char symbolKey;
            NSString *oldSymbol = objc_getAssociatedObject(button, &symbolKey);
            if (symbol != oldSymbol && ![oldSymbol isEqualToString:symbol]) {
                button.image = symbol ? [NSImage imageWithSystemSymbolName:symbol accessibilityDescription:nil] : nil;
                button.imagePosition = [symbol isEqualToString:@"chevron.right"] ? NSImageRight : NSImageLeft;
                button.imageHugsTitle = YES;
                button.symbolConfiguration = [NSImageSymbolConfiguration configurationWithPointSize:12 weight:NSFontWeightMedium];
                objc_setAssociatedObject(button, &symbolKey, symbol, OBJC_ASSOCIATION_COPY_NONATOMIC);
            }
            HBApplyTint(button, surface, item[@"tint"]);
        }
    }
    for (NSString *identifier in remaining) {
        [self.surfaces[identifier] removeFromSuperview];
        [self.surfaces removeObjectForKey:identifier];
        [self.controls removeObjectForKey:identifier];
    }
    return YES;
}
@end

bool homeworkbook_update_macos_content_controls(void *webviewPointer, const char *json) {
    if (![NSThread isMainThread] || !webviewPointer || !json) return false;
    WKWebView *webview = (__bridge WKWebView *)webviewPointer;
    NSData *data = [NSData dataWithBytes:json length:strlen(json)];
    id items = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![items isKindOfClass:NSArray.class]) return false;
    static char associationKey;
    HBContentControls *content = objc_getAssociatedObject(webview, &associationKey);
    if (!content || content.host.superview != webview.superview) {
        [content.host removeFromSuperview];
        content = [[HBContentControls alloc] initWithWebview:webview];
        if (!content) return false;
        objc_setAssociatedObject(webview, &associationKey, content, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    return [content apply:items];
}

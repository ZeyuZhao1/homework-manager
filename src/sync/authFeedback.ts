export function authFeedback(search: string): { message: string; failed: boolean } | null {
  const params = new URLSearchParams(search)
  const provider = params.get('provider') === 'google' ? 'Google' : params.get('provider') === 'github' ? 'GitHub' : '第三方账号'
  const errors: Record<string, string> = {
    token_config: `${provider} 服务端凭据校验失败，请更新私有 Client ID / Client Secret。`,
    token_code: '授权码验证失败或已失效，请重新发起授权。',
    token_redirect: 'OAuth 回调地址与注册配置不一致，请检查配置。',
    token_network: `无法连接 ${provider} 交换授权凭据，请稍后重试。`,
    token_response: `${provider} 返回的授权结果无效，请重试。`,
    identity_network: `${provider} 已返回授权，但暂时无法读取账号信息。`,
    identity_denied: `${provider} 已返回授权，但账号信息请求被拒绝，请稍后重试。`,
    identity_response: `${provider} 返回的账号信息无效，请重试。`,
    bind_session: '当前浏览器不是发起绑定的已授权设备。请返回原 PWA，或先在 Safari 完成设备配对后绑定。',
    bind_storage: '账号验证已完成，但绑定保存失败，请重试。',
    session_issue: '账号验证已完成，但无法建立登录会话，请重试。',
    cancelled: '已取消授权，可重新尝试。', unbound: '此账号尚未绑定，请先在已授权网页中绑定。',
    already_bound: '已绑定其他账号，请先解除原绑定。', state: '授权已过期或浏览器会话不匹配，请重新尝试。',
    session: '请先通过设备配对登录，再绑定第三方账号。', unavailable: '此登录方式尚未配置或暂时不可用。',
    rate: '尝试次数过多，请稍后重试。', failed: '身份认证未完成，请重试。',
  }
  if (params.has('auth_error')) return { message: errors[params.get('auth_error') || ''] || errors.failed, failed: true }
  const result = params.get('auth') || params.get('recovery')
  if (result === 'bound') return { message: `已绑定 ${provider}，可用于新设备登录。`, failed: false }
  if (result === 'complete') return { message: `已通过 ${provider} 登录。`, failed: false }
  return null
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authFeedback } from '../src/sync/authFeedback.ts'

test('OAuth feedback uses fixed labels and ignores arbitrary query content', () => {
  assert.equal(authFeedback('?auth=bound&provider=github').message, '已绑定 GitHub，可用于新设备登录。')
  assert.equal(authFeedback('?auth=complete&provider=google').message, '已通过 Google 登录。')
  assert.equal(authFeedback('?auth_error=unbound').failed, true)
  assert.match(authFeedback('?auth_error=token_config&provider=github').message, /GitHub 服务端凭据校验失败/)
  assert.match(authFeedback('?auth_error=bind_session').message, /原 PWA/)
  assert.equal(authFeedback('?auth_error=access_token%3Dsecret&provider=%3Cscript%3E').message, '身份认证未完成，请重试。')
  assert.equal(authFeedback('?auth=unknown'), null)
  assert.equal(authFeedback(''), null)
})

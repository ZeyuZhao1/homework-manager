import { parseHTML } from './parser.js';
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg.target !== 'parser') return;
  try { reply({ok:true, data:parseHTML(msg.html, msg.url, msg.kind)}); }
  catch (e) { reply({ok:false,error:e.message}); }
});

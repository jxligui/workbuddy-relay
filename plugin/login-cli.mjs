// One-shot web sign-in for the WorkBuddy gateway. Run when credentials are
// missing or expired:
//   node plugin/login-cli.mjs
// Writes %USERPROFILE%\.workbuddy-relay\credential.json, which the plugin reads.
import { startLogin, pollLogin } from "./lib/login.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const session = await startLogin({ open: true });
console.log(`浏览器已打开授权页（如未打开请手动访问）：\n${session.verificationUri}`);
console.log("等待授权完成…");

for (;;) {
  const result = await pollLogin(session.loginId);
  if (result.done) {
    if (result.error) {
      console.error(`登录失败：${result.error}`);
      process.exit(1);
    }
    console.log(`登录成功：${result.account?.nickname ?? result.account?.uid ?? "(account)"}`);
    process.exit(0);
  }
  await sleep(2000);
}

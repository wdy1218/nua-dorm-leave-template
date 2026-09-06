const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const readline = require("node:readline/promises");
const { chromium } = require("playwright");

const TARGET_ROOT =
  "https://v.nua.edu.cn/https/77726476706e69737468656265737421e3e24689263e265e6b09c7a99c406d3693";
const TARGET_URL = `${TARGET_ROOT}/feature-page`;

function getDefaultSessionDir() {
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "NUADormLeave",
    );
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "NUADormLeave",
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "NUADormLeave",
  );
}

const SESSION_DIR = getDefaultSessionDir();
const SESSION_STATE_PATH =
  process.env.NUA_SESSION_STATE_PATH ||
  path.join(SESSION_DIR, "session-state.json");
const COPY_EXISTING = process.argv.includes("--copy-existing");

function printHelp() {
  process.stdout.write(
    [
      "用法：node scripts/refresh-session-secret.cjs [--copy-existing]",
      "",
      "默认：打开可见浏览器，等待本人完成 WebVPN/宿舍登录和安全验证，",
      "      保存新的 storageState，并将 Base64 复制到系统剪贴板。",
      "--copy-existing：不打开浏览器，只复制已有 session-state.json 的 Base64。",
      "",
    ].join("\n"),
  );
}

function validateState() {
  if (!fs.existsSync(SESSION_STATE_PATH)) {
    throw new Error(`找不到会话文件：${SESSION_STATE_PATH}`);
  }
  const state = JSON.parse(fs.readFileSync(SESSION_STATE_PATH, "utf8"));
  if (!Array.isArray(state.cookies) || state.cookies.length === 0) {
    throw new Error("会话文件中没有 Cookie，请先重新登录。 ");
  }
  return state;
}

function copySecret() {
  validateState();
  const encoded = fs.readFileSync(SESSION_STATE_PATH).toString("base64");

  const clipboardOptions = {
    input: encoded,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "ignore"],
  };

  if (process.platform === "darwin") {
    execFileSync("/usr/bin/pbcopy", [], clipboardOptions);
  } else if (process.platform === "win32") {
    execFileSync("clip.exe", [], clipboardOptions);
  } else {
    let copied = false;
    for (const [command, args] of [
      ["wl-copy", []],
      ["xclip", ["-selection", "clipboard"]],
    ]) {
      try {
        execFileSync(command, args, clipboardOptions);
        copied = true;
        break;
      } catch {
        // Try the next common Linux clipboard utility.
      }
    }
    if (!copied) {
      throw new Error(
        "找不到 Linux 剪贴板工具；请安装 wl-clipboard 或 xclip，或按 README 的备用方式编码。",
      );
    }
  }

  process.stdout.write(
    "新的 NUA_SESSION_STATE_B64 已复制到剪贴板；未在终端显示内容。\n",
  );
  process.stdout.write(
    "请到 GitHub → Settings → Secrets and variables → Actions 更新同名 Secret。\n",
  );
}

async function launchVisibleBrowser() {
  const candidates = [
    ["Microsoft Edge", { channel: "msedge", headless: false }],
    ["Google Chrome", { channel: "chrome", headless: false }],
    ["Playwright Chromium", { headless: false }],
  ];
  const errors = [];

  for (const [name, options] of candidates) {
    try {
      return await chromium.launch(options);
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  }

  throw new Error(
    `无法启动可见浏览器：${errors.join(" | ")}\n` +
      "请先运行 npm install 和 npx playwright install chromium。",
  );
}

async function isDormFeaturePage(page) {
  const currentUrl = page.url();
  if (!currentUrl.startsWith(TARGET_ROOT) || currentUrl.includes("/cas/login")) {
    return false;
  }
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return (
    bodyText.includes("智慧宿舍") &&
    (bodyText.includes("申请入口") || bodyText.includes("请假"))
  );
}

async function refreshSession() {
  fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  const browser = await launchVisibleBrowser();
  const contextOptions = {};
  if (fs.existsSync(SESSION_STATE_PATH)) {
    contextOptions.storageState = SESSION_STATE_PATH;
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    await page.goto(TARGET_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    process.stdout.write(
      [
        "已打开学校页面。请在可见浏览器中亲自完成登录和滑块验证。",
        "如果统一认证后跳到其他页面，请在同一窗口重新打开最初的智慧宿舍网址，",
        "并继续完成宿舍系统登录，直到看到“智慧宿舍管理平台”的功能页。",
        "脚本不会读取、打印或上传你的密码。",
        "",
      ].join("\n"),
    );

    while (!(await isDormFeaturePage(page))) {
      await terminal.question("确认已经看到智慧宿舍功能页后按回车：");
      if (!(await isDormFeaturePage(page))) {
        process.stdout.write("当前页面尚未识别为智慧宿舍功能页，请继续登录后再试。\n");
      }
    }

    await context.storageState({ path: SESSION_STATE_PATH });
    fs.chmodSync(SESSION_STATE_PATH, 0o600);
  } finally {
    terminal.close();
    await context.close();
    await browser.close();
  }

  copySecret();
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }
  if (COPY_EXISTING) {
    copySecret();
    return;
  }
  await refreshSession();
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

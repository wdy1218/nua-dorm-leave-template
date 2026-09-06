const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const PROJECT_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(PROJECT_DIR, "config.json");
const SESSION_STATE_PATH =
  path.join(os.homedir(), "Library/Application Support/NUADormLeave/session-state.json");
const OUTPUT_PATH = path.join(PROJECT_DIR, "api-dry-run-plan.json");
const TARGET_ROOT =
  "https://v.nua.edu.cn/https/77726476706e69737468656265737421e3e24689263e265e6b09c7a99c406d3693";
const API_ROOT = `${TARGET_ROOT}/api1`;
const VPN_MARKER = "vpn-12-o2-suguan.nua.edu.cn";
const FIRST_VERIFICATION_DELAY_MS = 20_000;
const LATER_VERIFICATION_DELAY_MS = 10_000;
const VERIFICATION_ATTEMPTS = 6;
const args = new Set(process.argv.slice(2));
const submitEnabled = args.has("--submit");
const notificationTest = args.has("--test-notifications");
const allowReapplyCancelled = args.has("--allow-reapply-cancelled");

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function serverChanEndpoint(sendKey) {
  if (sendKey.startsWith("SCT")) {
    return `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`;
  }
  const sc3 = sendKey.match(/^sctp(\d+)t/i);
  if (sc3) {
    return (
      `https://${sc3[1]}.push.ft07.com/send/` +
      `${encodeURIComponent(sendKey)}.send`
    );
  }
  throw new Error("无法识别 Server酱 SendKey 类型。");
}

async function notifyServerChan(title, description) {
  const sendKey = process.env.SERVERCHAN_SENDKEY;
  if (!sendKey) return false;
  try {
    const response = await fetch(serverChanEndpoint(sendKey), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title, desp: description }),
    });
    const result = await response.json();
    if (!response.ok || Number(result?.code) !== 0) {
      throw new Error("Server酱返回非成功状态。");
    }
    log("Server酱通知发送成功。");
    return true;
  } catch (error) {
    log(`Server酱通知发送失败：${error.message}`);
    return false;
  }
}

async function notifyPushDeer(title, description) {
  const pushKey = process.env.PUSHDEER_PUSHKEY;
  if (!pushKey) return false;
  try {
    const response = await fetch("https://api2.pushdeer.com/message/push", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        pushkey: pushKey,
        text: title,
        desp: description,
        type: "markdown",
      }),
    });
    const result = await response.json();
    if (!response.ok || Number(result?.code) !== 0) {
      throw new Error("PushDeer 返回非成功状态。");
    }
    log("PushDeer 通知发送成功。");
    return true;
  } catch (error) {
    log(`PushDeer 通知发送失败：${error.message}`);
    return false;
  }
}

async function notifyAll(title, description) {
  const results = await Promise.all([
    notifyServerChan(title, description),
    notifyPushDeer(title, description),
  ]);
  return {
    serverChan: results[0],
    pushDeer: results[1],
  };
}

function workflowRunUrl() {
  const serverUrl = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!serverUrl || !repository || !runId) return "";
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

function readConfig() {
  const sourcePath = fs.existsSync(CONFIG_PATH)
    ? CONFIG_PATH
    : path.join(PROJECT_DIR, "config.example.json");
  const config = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const overrides = {
    account: process.env.NUA_ACCOUNT,
    reason: process.env.NUA_REASON,
    destination: process.env.NUA_DESTINATION,
    boundaryTime: process.env.NUA_BOUNDARY_TIME,
    leadHours: process.env.NUA_LEAD_HOURS,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== "") config[key] = value;
  }
  const required = ["account", "reason", "destination", "boundaryTime", "leadHours"];
  for (const key of required) {
    if (config[key] === undefined || String(config[key]).trim() === "") {
      throw new Error(`缺少配置：${key}`);
    }
  }
  const durationHours = Number(config.durationHours);
  if (!Number.isFinite(durationHours) || durationHours <= 0 || durationHours > 72) {
    throw new Error("durationHours 必须大于 0 且不超过 72。");
  }
  return config;
}

function readSessionState() {
  if (process.env.NUA_SESSION_STATE_B64) {
    return JSON.parse(
      Buffer.from(process.env.NUA_SESSION_STATE_B64, "base64").toString("utf8"),
    );
  }
  return JSON.parse(fs.readFileSync(SESSION_STATE_PATH, "utf8"));
}

function dormPassword(account) {
  if (process.env.NUA_DORM_PASSWORD) return process.env.NUA_DORM_PASSWORD;
  try {
    return execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-a", account, "-s", "nua-dorm-inner", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    throw new Error("无法读取智慧宿舍密码。");
  }
}

function cookieHeader(storageState) {
  const now = Date.now();
  const hostname = "v.nua.edu.cn";
  const cookies = (storageState.cookies || []).filter((cookie) => {
    const domain = String(cookie.domain || "").replace(/^\./, "");
    const domainMatches = hostname === domain || hostname.endsWith(`.${domain}`);
    const notExpired = cookie.expires === -1 || Number(cookie.expires) * 1000 > now;
    return domainMatches && notExpired;
  });
  if (!cookies.length) throw new Error("WebVPN 会话中没有可用 Cookie。");
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function requestJson(
  pathname,
  { cookie, accessToken, params, login, method = "GET", body } = {},
) {
  const url = new URL(`${API_ROOT}${pathname}`);
  url.searchParams.set(VPN_MARKER, "");
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, String(value));
  }

  const headers = {
    accept: "application/json, text/plain, */*",
    cookie,
    referer: `${TARGET_ROOT}/`,
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  };
  if (accessToken) headers.accesstoken = accessToken;
  if (login) {
    headers.authorization = "Basic YXBwOmFwcA==";
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  if (body !== undefined) headers["content-type"] = "application/json;charset=UTF-8";

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`WebVPN 会话已失效：HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${pathname}`);

  const data = await response.json();
  if (data && data.code !== undefined && Number(data.code) !== 200) {
    throw new Error(`接口返回非成功状态：code=${data.code}`);
  }
  return data;
}

function parseLocal(value) {
  const match = String(value || "").match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (!match) return null;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] || 0),
  );
}

function formatLocal(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function nextBoundary(now, value) {
  const [hour, minute] = value.split(":").map(Number);
  const result = new Date(now);
  result.setHours(hour, minute, 0, 0);
  if (result <= now) result.setDate(result.getDate() + 1);
  return result;
}

function chooseInterval(records, config, now = new Date(), options = {}) {
  const allowCancelled = options.allowReapplyCancelled === true;
  const ignoredStatuses = new Set(["审批驳回", "已撤销"]);
  const usable = records
    .filter(
      (record) =>
        !isCancelled(record) &&
        !ignoredStatuses.has(record.type) &&
        !ignoredStatuses.has(record.status),
    )
    .map((record) => ({ ...record, parsedEnd: parseLocal(record.leaveEndTime) }))
    .filter((record) => record.parsedEnd)
    .sort((left, right) => right.parsedEnd - left.parsedEnd);

  let start;
  if (usable[0]?.parsedEnd > now) {
    start = nextBoundary(usable[0].parsedEnd, config.boundaryTime);
  } else {
    start = nextBoundary(now, config.boundaryTime);
  }
  const end = new Date(
    start.getTime() + Number(config.durationHours) * 60 * 60 * 1000,
  );
  start.setSeconds(0, 0);
  end.setSeconds(0, 0);
  const durationHours = (end - start) / 3_600_000;
  const hoursUntilStart = (start - now) / 3_600_000;
  const duplicate = records.some((record) => {
    const recordStart = parseLocal(record.leaveStartTime);
    const recordEnd = parseLocal(record.leaveEndTime);
    const exactInterval =
      recordStart?.getTime() === start.getTime() &&
      recordEnd?.getTime() === end.getTime();
    if (!exactInterval) return false;
    return !(allowCancelled && isCancelled(record));
  });
  return {
    start,
    end,
    durationHours,
    hoursUntilStart,
    due: hoursUntilStart <= Number(config.leadHours),
    duplicate,
  };
}

function formatLeaveLength(durationHours) {
  let minutes = Math.round(durationHours * 60);
  const days = Math.floor(minutes / (24 * 60));
  minutes %= 24 * 60;
  const hours = Math.floor(minutes / 60);
  minutes %= 60;
  return (
    `${days ? `${days}天` : ""}` +
    `${hours ? `${hours}小时` : ""}` +
    `${minutes ? `${minutes}分钟` : ""}`
  );
}

function isCancelled(record) {
  return (
    record.type === "已撤销" ||
    record.status === "已撤销"
  );
}

function isSubmissionWindow(now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= 7 * 60 && minutes <= 18 * 60;
}

function sameInterval(record, interval) {
  const unsuccessfulStatuses = new Set(["审批驳回", "已撤销"]);
  return (
    parseLocal(record.leaveStartTime)?.getTime() === interval.start.getTime() &&
    parseLocal(record.leaveEndTime)?.getTime() === interval.end.getTime() &&
    !isCancelled(record) &&
    !unsuccessfulStatuses.has(record.type) &&
    !unsuccessfulStatuses.has(record.status)
  );
}

async function main() {
  const config = readConfig();
  if (notificationTest) {
    const runUrl = workflowRunUrl();
    const result = await notifyAll(
      "宿舍请假双通道通知测试",
      [
        "### 自动化状态",
        "- Server酱：已配置",
        "- PushDeer：已配置",
        "- GitHub Actions：已连接",
        "- 定时检查：每天 09:17、16:17",
        "- 请假规则：18:00 开始，第三天 08:00 结束，共 62 小时",
        "- 提前申请：36 小时",
        "- 通知策略：成功与失败双通道通知，普通跳过保持静默",
        "",
        "**当前状态：仅测试双通道通知，未提交请假。**",
        ...(runUrl ? ["", `[查看 GitHub Actions 运行详情](${runUrl})`] : []),
      ].join("\n"),
    );
    if (!result.serverChan || !result.pushDeer) {
      throw new Error("双通道通知测试未全部成功。");
    }
    log("Server酱和 PushDeer 双通道通知测试均成功。");
    return;
  }
  const storageState = readSessionState();
  const cookie = cookieHeader(storageState);
  const passwordHash = crypto
    .createHash("md5")
    .update(dormPassword(config.account), "utf8")
    .digest("hex");

  const login = await requestJson("/login/user/login", {
    cookie,
    login: true,
    params: {
      loginName: config.account,
      password: passwordHash,
      code: "",
    },
  });
  const accessToken = login?.data?.accessToken;
  if (!accessToken) throw new Error("宿舍登录成功响应中没有 accessToken。");
  log("纯 HTTP 宿舍登录成功。");

  const recordResponse = await requestJson(
    "/process/studentLeaveApplicationMaster/findLeaveRecordsByCode",
    {
      cookie,
      accessToken,
      params: { pageSize: 9999, pageNum: 1, code: config.account },
    },
  );
  const records = Array.isArray(recordResponse?.dataList)
    ? recordResponse.dataList
    : Array.isArray(recordResponse?.data?.dataList)
      ? recordResponse.data.dataList
      : [];
  log(`纯 HTTP 请假记录查询成功：${records.length} 条。`);

  if (allowReapplyCancelled) {
    log(
      "手动撤销后重提模式已启用：已撤销的同区间记录不阻止本次申请，" +
        "审批驳回等其他同区间记录仍会阻止提交。",
    );
  }
  const interval = chooseInterval(records, config, new Date(), {
    allowReapplyCancelled,
  });
  log(
    `下一段：${formatLocal(interval.start)} → ${formatLocal(interval.end)}` +
      `，时长 ${interval.durationHours.toFixed(2)} 小时` +
      `，距开始 ${interval.hoursUntilStart.toFixed(1)} 小时。`,
  );

  if (interval.duplicate) {
    log("已存在相同起止时间的记录，本次跳过。");
    return;
  }
  if (!interval.due) {
    log(`尚未进入提前 ${config.leadHours} 小时的申请窗口，本次跳过。`);
    return;
  }
  if (!isSubmissionWindow()) {
    log("当前不在允许申请的 07:00–18:00 时段，本次跳过。");
    return;
  }

  const approval = await requestJson(
    "/process/studentLeaveApplicationMaster/findApprovalProcessByTime",
    {
      cookie,
      accessToken,
      params: {
        code: config.account,
        period: interval.durationHours.toFixed(2),
        id: 1,
        childId: config.leaveTypeId,
      },
    },
  );
  const approvalProcessMasterId = approval?.data?.id ?? approval?.id;
  if (!approvalProcessMasterId) throw new Error("未获取到审批流程 ID。");

  const submitBody = {
    lengthOfLeave: formatLeaveLength(interval.durationHours),
    leaveStartTime: formatLocal(interval.start),
    leaveEndTime: formatLocal(interval.end),
    description: config.reason,
    goOnLeave: config.destination,
    code: config.account,
    approvalProcessMasterId: String(approvalProcessMasterId),
    processTypeId: String(config.leaveTypeId),
  };
  const plan = {
    createdAt: new Date().toISOString(),
    mode: submitEnabled ? "submit" : "dry-run",
    transport: "direct-http",
    startTime: submitBody.leaveStartTime,
    endTime: submitBody.leaveEndTime,
    durationHours: interval.durationHours,
    approvalProcessPresent: true,
    submitEndpoint:
      "/api1/process/studentLeaveApplicationMaster/insert",
    submitFieldNames: Object.keys(submitBody),
    postSent: false,
    verified: false,
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(OUTPUT_PATH, 0o600);
  if (!submitEnabled) {
    log(
      `纯 HTTP 预演完成：${plan.startTime} → ${plan.endTime}；未发送 POST。`,
    );
    return;
  }

  if (process.env.NUA_ENABLE_SUBMIT !== "I_UNDERSTAND_AUTOMATIC_SUBMISSION") {
    throw new Error("未设置自动提交安全开关，已停止。");
  }

  log("所有校验通过，正在发送唯一一次 POST 提交请求。");
  plan.postSent = true;
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  let submitResponseError = null;
  try {
    await requestJson("/process/studentLeaveApplicationMaster/insert", {
      cookie,
      accessToken,
      method: "POST",
      body: submitBody,
    });
    log("POST 已返回成功响应；等待学校记录落库后再确认。");
  } catch (error) {
    submitResponseError = error;
    log(
      `POST 响应未确认（${error.message}）；不会重发 POST，` +
        "将等待并通过只读记录查询核实结果。",
    );
  }

  let verified = false;
  for (let attempt = 1; attempt <= VERIFICATION_ATTEMPTS; attempt += 1) {
    const delayMs =
      attempt === 1 ? FIRST_VERIFICATION_DELAY_MS : LATER_VERIFICATION_DELAY_MS;
    log(
      `等待 ${(delayMs / 1000).toFixed(0)} 秒后进行第 ${attempt}/` +
        `${VERIFICATION_ATTEMPTS} 次只读回查。`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const verificationResponse = await requestJson(
        "/process/studentLeaveApplicationMaster/findLeaveRecordsByCode",
        {
          cookie,
          accessToken,
          params: { pageSize: 9999, pageNum: 1, code: config.account },
        },
      );
      const verificationRecords = Array.isArray(verificationResponse?.dataList)
        ? verificationResponse.dataList
        : Array.isArray(verificationResponse?.data?.dataList)
          ? verificationResponse.data.dataList
          : [];
      if (verificationRecords.some((record) => sameInterval(record, interval))) {
        verified = true;
        log(`第 ${attempt} 次只读回查已找到本次请假记录。`);
        break;
      }
      log(`第 ${attempt} 次只读回查尚未找到本次请假记录。`);
    } catch (error) {
      log(`第 ${attempt} 次只读回查失败：${error.message}`);
    }
  }
  if (!verified) {
    const responseNote = submitResponseError
      ? `POST 响应异常：${submitResponseError.message}；`
      : "POST 已返回成功响应；";
    throw new Error(
      `${responseNote}等待并多次查询后仍未确认记录；不会自动重试 POST。`,
    );
  }
  plan.verified = true;
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  log("自动提交成功，且已在请假记录中确认。");
  const nextStart = nextBoundary(interval.end, config.boundaryTime);
  const nextEnd = new Date(
    nextStart.getTime() + Number(config.durationHours) * 60 * 60 * 1000,
  );
  const runUrl = workflowRunUrl();
  await notifyAll(
    "宿舍请假自动提交成功",
    [
      "### 本次申请",
      "- 状态：已提交，并在请假记录中确认",
      `- 类型：${config.leaveType || "事假"}`,
      `- 时间：${plan.startTime} → ${plan.endTime}`,
      `- 时长：${formatLeaveLength(interval.durationHours)}` +
        `（${interval.durationHours.toFixed(2)} 小时）`,
      `- 事由：${config.reason}`,
      `- 去向：${config.destination}`,
      "",
      "### 后续安排",
      `- 下一段预计：${formatLocal(nextStart)} → ${formatLocal(nextEnd)}`,
      "- 普通的未到期或重复检查不会推送消息",
      ...(runUrl ? ["", `[查看 GitHub Actions 运行详情](${runUrl})`] : []),
    ].join("\n"),
  );
}

if (require.main === module) {
  main().catch(async (error) => {
    process.stderr.write(`[${new Date().toISOString()}] ${error.stack || error}\n`);
    const runUrl = workflowRunUrl();
    if (!notificationTest) {
      await notifyAll(
        "宿舍请假自动化失败",
        [
          "### 执行失败",
          `- 时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
          `- 错误：${error.message}`,
          "- 本次不会自动重试提交 POST，请人工核对请假记录",
          ...(runUrl ? ["", `[查看 GitHub Actions 运行详情](${runUrl})`] : []),
        ].join("\n"),
      );
    }
    process.exitCode = 1;
  });
}

module.exports = {
  chooseInterval,
  formatLeaveLength,
  formatLocal,
  parseLocal,
  serverChanEndpoint,
  notifyAll,
  workflowRunUrl,
};

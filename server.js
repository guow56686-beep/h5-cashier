
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const BASE_DIR = __dirname;

function loadEnv() {
  const envPath = path.join(BASE_DIR, ".env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(PAY_GATEWAY_URL|PAY_MEMBER_ID|PAY_API_KEY|PAY_CLIENT_IP)\s*=\s*(.*?)\s*$/);
    if (!match) continue;

    const key = match[1];
    const value = match[2].replace(/^["']|["']$/g, "");

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnv();

const GATEWAY_URL =
  process.env.PAY_GATEWAY_URL ||
  "https://api.sf2027.xyz/gateway/Pay_Index.html";

const MEMBER_ID = process.env.PAY_MEMBER_ID || "";
const API_KEY = process.env.PAY_API_KEY || "";
const CLIENT_IP = process.env.PAY_CLIENT_IP || "";

const SITE_URL = "https://h5-cashier-2.onrender.com";
const NOTIFY_URL = `${SITE_URL}/api/pay-notify`;
const CALLBACK_URL = `${SITE_URL}/payment-result`;

const orders = new Map();

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    const limit = 1024 * 1024;

    req.on("data", chunk => {
      size += chunk.length;

      if (size > limit) {
        reject(new Error("请求内容过大"));
        req.destroy();
        return;
      }

      body += chunk.toString("utf8");
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseForm(body) {
  return Object.fromEntries(new URLSearchParams(body));
}

function makeSign(params) {
  if (!API_KEY) {
    throw new Error("未配置 PAY_API_KEY");
  }

  const content = Object.keys(params)
    .filter(key =>
      key !== "sign" &&
      key !== "pay_md5sign" &&
      params[key] !== undefined &&
      params[key] !== null &&
      String(params[key]) !== ""
    )
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join("&");

  return crypto
    .createHash("md5")
    .update(`${content}&key=${API_KEY}`, "utf8")
    .digest("hex")
    .toUpperCase();
}

function verifySign(params) {
  const received = String(params.sign || params.pay_md5sign || "")
    .toUpperCase();

  if (!received) return false;

  const copy = { ...params };
  delete copy.sign;
  delete copy.pay_md5sign;

  const expected = makeSign(copy);

  if (received.length !== expected.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(received),
    Buffer.from(expected)
  );
}

function normalizeAmount(value) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0 || number > 1000000) {
    throw new Error("订单金额无效");
  }

  return number.toFixed(2);
}

function newOrderId() {
  return "HF" + Date.now() +
    crypto.randomBytes(4).toString("hex").toUpperCase();
}

function amountMatches(a, b) {
  return Number(a).toFixed(2) === Number(b).toFixed(2);
}

function getClientIp(req) {
  // 优先使用由部署环境配置的客户端公网 IP。
  if (CLIENT_IP) return CLIENT_IP;

  // Render 等可信反向代理通常会提供此请求头。
  // 不要在未验证代理配置时把任意客户端提交的 IP 当作可信身份。
  const forwarded = req.headers["x-forwarded-for"];

  if (forwarded && process.env.RENDER) {
    const candidate = String(forwarded).split(",")[0].trim();

    if (candidate && !candidate.includes(",")) {
      return candidate;
    }
  }

  return req.socket.remoteAddress || "";
}

async function postGateway(url, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000)
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`支付平台 HTTP ${response.status}`);
  }

  let result;

  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error("支付平台返回的不是 JSON");
  }

  return result;
}

async function queryGatewayOrder(orderId) {
  const gateway = new URL(GATEWAY_URL);
  const queryUrl = new URL("/Pay_Trade_query.html", gateway.origin);

  const params = {
    pay_memberid: MEMBER_ID,
    pay_orderid: orderId
  };

  params.pay_md5sign = makeSign(params);

  return postGateway(queryUrl.toString(), params);
}

async function verifyPaidOrder(order, notify) {
  if (!verifySign(notify)) {
    throw new Error("支付通知签名验证失败");
  }

  const notifyOrderId = String(
    notify.orderid || notify.pay_orderid || ""
  );

  if (notifyOrderId !== order.orderId) {
    throw new Error("支付通知订单号不匹配");
  }

  const notifyMemberId = String(
    notify.memberid || notify.pay_memberid || ""
  );

  if (notifyMemberId && notifyMemberId !== MEMBER_ID) {
    throw new Error("支付通知商户号不匹配");
  }

  const notifyAmount = notify.amount || notify.pay_amount;

  if (!notifyAmount || !amountMatches(notifyAmount, order.amount)) {
    throw new Error("支付通知金额不匹配");
  }

  const notifyStatus = String(
    notify.returncode || notify.trade_status || notify.status || ""
  ).toUpperCase();

  if (!["00", "SUCCESS", "1"].includes(notifyStatus)) {
    throw new Error("支付通知未表明支付成功");
  }

  // 通知本身不能单独作为到账依据，再查询支付平台。
  const query = await queryGatewayOrder(order.orderId);

  if (!verifySign(query)) {
    throw new Error("支付查询结果签名验证失败");
  }

  const queryOrderId = String(
    query.orderid || query.pay_orderid || ""
  );

  if (queryOrderId !== order.orderId) {
    throw new Error("支付查询订单号不匹配");
  }

  const queryMemberId = String(
    query.memberid || query.pay_memberid || ""
  );

  if (queryMemberId && queryMemberId !== MEMBER_ID) {
    throw new Error("支付查询商户号不匹配");
  }

  const queryAmount = query.amount || query.pay_amount;

  if (!queryAmount || !amountMatches(queryAmount, order.amount)) {
    throw new Error("支付查询金额不匹配");
  }

  const status = String(
    query.trade_status || query.status || query.returncode || ""
  ).toUpperCase();

  if (!["SUCCESS", "TRADE_SUCCESS", "00"].includes(status)) {
    throw new Error("支付平台查询结果尚未确认成功");
  }

  order.status = "PAID";
  order.transactionId = String(
    notify.transaction_id || notify.transid || ""
  );
  order.paidAt = new Date().toISOString();

  return order;
}

function getOrderPublicInfo(order) {
  return {
    orderId: order.orderId,
    amount: order.amount,
    status: order.status,
    createdAt: order.createdAt,
    paidAt: order.paidAt || null
  };
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  if (req.method === "GET" && requestUrl.pathname === "/") {
    const indexPath = path.join(BASE_DIR, "index.html");

    if (!fs.existsSync(indexPath)) {
      return sendText(res, 404, "未找到 index.html");
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });

    return fs.createReadStream(indexPath).pipe(res);
  }

  if (req.method === "GET" &&
      requestUrl.pathname === "/api/pay-config-check") {
    return sendJson(res, 200, {
      gatewayConfigured: Boolean(GATEWAY_URL),
      memberIdConfigured: Boolean(MEMBER_ID),
      apiKeyConfigured: Boolean(API_KEY),
      clientIpConfigured: Boolean(CLIENT_IP)
    });
  }

  if (req.method === "POST" &&
      requestUrl.pathname === "/api/order") {
    let order = null;

    try {
      if (!MEMBER_ID || !API_KEY || !GATEWAY_URL) {
        return sendJson(res, 500, {
          success: false,
          message: "支付配置不完整，请检查服务器环境变量"
        });
      }

      const body = await readBody(req);
      let input;

      try {
        input = JSON.parse(body || "{}");
      } catch {
        return sendJson(res, 400, {
          success: false,
          message: "请求内容不是有效 JSON"
        });
      }

      const amount = normalizeAmount(input.amount);
      const orderId = newOrderId();

      order = {
        orderId,
        amount,
        currency: "CNY",
        status: "SUBMITTING",
        createdAt: new Date().toISOString()
      };

      orders.set(orderId, order);

      const params = {
        pay_memberid: MEMBER_ID,
        pay_orderid: orderId,
        pay_applydate: new Date().toISOString()
          .slice(0, 19).replace("T", " "),
        pay_bankcode: "942",
        pay_notifyurl: NOTIFY_URL,
        pay_callbackurl: CALLBACK_URL,
        pay_amount: amount,
        pay_productname: "H5商城订单",
        pay_post: "json",
        pay_ip: getClientIp(req)
      };

      params.pay_md5sign = makeSign(params);

      let gatewayResult;

      try {
        gatewayResult = await postGateway(GATEWAY_URL, params);
      } catch (error) {
        // 请求超时或网络中断时，不能证明平台没有创建订单。
        order.status = "SUBMIT_UNKNOWN";
        order.error = error.name === "TimeoutError" ||
          error.name === "AbortError"
          ? "请求超时，支付平台是否收到订单尚不确定"
          : error.message;

        console.error("Gateway request outcome unknown:", error.message);

        return sendJson(res, 504, {
          success: false,
          outcomeUnknown: true,
          message: "支付平台响应异常，订单结果尚不确定。请先查询平台商户后台，不要立即重复下单。",
          order: getOrderPublicInfo(order)
        });
      }

      const gatewayStatus = String(
        gatewayResult.status || ""
      ).toLowerCase();

      if (gatewayStatus !== "success") {
        order.status = "CREATE_REJECTED";

        console.error(
          "Gateway rejected order:",
          JSON.stringify({
            status: gatewayResult.status || "",
            message: gatewayResult.msg || gatewayResult.message || ""
          })
        );

        return sendJson(res, 502, {
          success: false,
          outcomeUnknown: false,
          message: "支付平台未确认下单成功，请查看平台返回信息及商户后台。",
          gatewayMessage: gatewayResult.msg ||
            gatewayResult.message || ""
        });
      }

      const data = gatewayResult.data;

      if (typeof data !== "string" || !data.trim()) {
        order.status = "SUBMIT_UNKNOWN";

        return sendJson(res, 502, {
          success: false,
          outcomeUnknown: true,
          message: "平台已返回成功状态，但未提供有效支付地址，请先查询商户后台。",
          order: getOrderPublicInfo(order)
        });
      }

      let paymentUrl;

      try {
        paymentUrl = new URL(data);
      } catch {
        order.status = "SUBMIT_UNKNOWN";

        return sendJson(res, 502, {
          success: false,
          outcomeUnknown: true,
          message: "平台返回的数据不是可识别的支付链接，请先查询商户后台。",
          order: getOrderPublicInfo(order)
        });
      }

      if (paymentUrl.protocol !== "https:") {
        order.status = "SUBMIT_UNKNOWN";

        return sendJson(res, 502, {
          success: false,
          outcomeUnknown: true,
          message: "平台返回的支付链接不是 HTTPS，请先核实平台返回结果。",
          order: getOrderPublicInfo(order)
        });
      }

      order.status = "WAITING";
      order.paymentUrl = paymentUrl.toString();

      return sendJson(res, 200, {
        success: true,
        message: "订单已创建，请继续支付",
        order: getOrderPublicInfo(order),
        paymentUrl: order.paymentUrl,
        backtype: gatewayResult.backtype || ""
      });
    } catch (error) {
      console.error("Create order error:", error.message);

      if (order) {
        order.status = "SUBMIT_UNKNOWN";
        order.error = error.message;
      }

      return sendJson(res, 500, {
        success: false,
        outcomeUnknown: Boolean(order),
        message: order
          ? "下单处理出现异常，订单结果尚不确定。请先查询商户后台，不要立即重复下单。"
          : error.message
      });
    }
  }

  if (req.method === "GET" &&
      requestUrl.pathname === "/api/order") {
    const orderId = requestUrl.searchParams.get("orderId");

    if (!orderId) {
      return sendJson(res, 400, {
        success: false,
        message: "缺少 orderId"
      });
    }

    const order = orders.get(orderId);

    if (!order) {
      return sendJson(res, 404, {
        success: false,
        message: "本次服务器进程中没有找到该订单；这不代表支付平台没有订单"
      });
    }

    return sendJson(res, 200, {
      success: true,
      order: getOrderPublicInfo(order)
    });
  }

  if (req.method === "POST" &&
      requestUrl.pathname === "/api/pay-notify") {
    try {
      const body = await readBody(req);
      const contentType = String(req.headers["content-type"] || "");

      let notify;

      if (contentType.includes("application/json")) {
        notify = JSON.parse(body || "{}");
      } else {
        notify = parseForm(body);
      }

      const orderId = String(
        notify.orderid || notify.pay_orderid || ""
      );

      const order = orders.get(orderId);

      if (!order) {
        console.error("Notification for unknown local order:", orderId);
        return sendText(res, 404, "FAIL");
      }

      if (order.status === "PAID") {
        return sendText(res, 200, "OK");
      }

      await verifyPaidOrder(order, notify);

      console.log("Payment confirmed:", order.orderId);
      return sendText(res, 200, "OK");
    } catch (error) {
      console.error("Payment notification rejected:", error.message);
      return sendText(res, 400, "FAIL");
    }
  }

  if (req.method === "GET" &&
      requestUrl.pathname === "/payment-result") {
    const orderId = requestUrl.searchParams.get("orderid") ||
      requestUrl.searchParams.get("pay_orderid") || "";

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });

    return res.end(`<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>支付结果</title></head>
<body style="font-family:Arial,sans-serif;padding:24px">
<h2>已返回商城</h2>
<p>订单号：${orderId.replace(/[&<>"']/g, "")}</p>
<p>浏览器跳转不代表支付成功，请以支付平台核实及服务器确认结果为准。</p>
</body></html>`);
  }

  return sendJson(res, 404, {
    success: false,
    message: "接口不存在"
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`H5 cashier server listening on port ${PORT}`);
});

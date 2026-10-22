
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 3000;
const BASE_DIR = __dirname;

// 本地演示订单：不连接真实支付系统
const demoOrder = {
  orderId: "DEMO20261022001",
  amount: 199.00,
  currency: "CNY",
  status: "WAITING"
};

const allowedStatuses = ["WAITING", "PAID", "EXPIRED", "RISK"];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  res.setHeader("Cache-Control", "no-store");

  // 获取服务端订单
  if (req.method === "GET" && url.pathname === "/api/order") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8"
    });
    res.end(JSON.stringify(demoOrder));
    return;
  }

  // 本地学习用：修改演示订单状态
  if (req.method === "POST" && url.pathname === "/api/demo-status") {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024) {
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        const data = JSON.parse(body);

        if (!allowedStatuses.includes(data.status)) {
          res.writeHead(400, {
            "Content-Type": "application/json; charset=utf-8"
          });
          res.end(JSON.stringify({ error: "无效的演示状态" }));
          return;
        }

        demoOrder.status = data.status;

        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({
          message: "演示订单状态已更新",
          order: demoOrder
        }));
      } catch {
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "请求数据格式不正确" }));
      }
    });

    return;
  }

  // 提供网页
  if (req.method === "GET" && url.pathname === "/") {
    fs.readFile(path.join(BASE_DIR, "index.html"), (err, content) => {
      if (err) {
        res.writeHead(500, {
          "Content-Type": "text/plain; charset=utf-8"
        });
        res.end("读取 index.html 失败，请检查文件是否存在。");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8"
      });
      res.end(content);
    });
    return;
  }

  res.writeHead(404, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`演示网页：http://127.0.0.1:${PORT}/`);
  console.log(`订单接口：http://127.0.0.1:${PORT}/api/order`);
  console.log("演示状态接口：POST http://127.0.0.1:3000/api/demo-status");
});

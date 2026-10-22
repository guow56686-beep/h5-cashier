
const demoOrder = {
  orderId: "DEMO20261022001",
  amount: 199.00,
  currency: "CNY",
  status: "WAITING",
  createdAt: new Date().toISOString()
};

const demoStatusLabels = {
  WAITING: "等待付款",
  PAID: "已支付（模拟）",
  EXPIRED: "链接过期（模拟）",
  RISK: "需要核实交易风险"
};

function getDemoOrder() {
  return { ...demoOrder };
}

function getDemoStatusLabel(status) {
  return demoStatusLabels[status] || "未知状态";
}

function canDemoRetry(status) {
  return status === "WAITING" || status === "EXPIRED";
}

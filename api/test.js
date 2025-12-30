// 使用 ES Module 语法导出处理函数
export default function handler(req, res) {
  // 设置响应状态码为 200 (成功) 并返回 JSON 数据
  res.status(200).json({ message: 'Hello from test API route!' });
}

// 可选：添加运行时日志，方便在 Vercel Dashboard 查看
console.log("Test API route accessed");
function cloudbaseConfig(environment, runtime = process.env) {
  const accessKey = String(runtime.CLOUDBASE_APIKEY || "").trim();
  if (!accessKey) {
    throw new Error(
      "CLOUDBASE_APIKEY 未配置。请在云开发控制台的环境配置 / API Key 管理中创建服务端 API Key，并添加到云托管环境变量。",
    );
  }
  return { env: environment, accessKey };
}

module.exports = { cloudbaseConfig };

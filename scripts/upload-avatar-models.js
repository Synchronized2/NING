const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const planPath = path.join(root, "artifacts/avatars/upload-plan.json");
const configPath = path.join(root, "miniprogram/utils/avatar-cloud-config.js");
const env = process.env.TCB_ENV || process.env.CLOUDBASE_ENV;
const secretId = process.env.TENCENTCLOUD_SECRETID;
const secretKey = process.env.TENCENTCLOUD_SECRETKEY;

if (!env || !secretId || !secretKey) {
  throw new Error("需要 TCB_ENV、TENCENTCLOUD_SECRETID 和 TENCENTCLOUD_SECRETKEY 环境变量；凭据不要写入仓库。");
}
if (!fs.existsSync(planPath)) throw new Error("请先运行 node scripts/build-avatar-catalog.js");
const { uploads } = JSON.parse(fs.readFileSync(planPath, "utf8"));
const cloud = require("../cloudfunctions/openaiProxy/node_modules/@cloudbase/node-sdk").init({ env, secretId, secretKey });

async function main() {
  let prefix = "";
  for (let index = 0; index < uploads.length; index += 1) {
    const file = uploads[index];
    const bytes = fs.readFileSync(file.source);
    if (bytes.length !== file.size || crypto.createHash("sha1").update(bytes).digest("hex") !== file.sha1) {
      throw new Error(`素材发生变化，请重新生成清单：${file.source}`);
    }
    const result = await cloud.uploadFile({ cloudPath: file.cloudPath, fileContent: fs.createReadStream(file.source) });
    const fileID = String(result.fileID || "");
    if (!fileID.startsWith("cloud://") || !fileID.endsWith(file.cloudPath)) {
      throw new Error(`云存储返回的 fileID 无法验证：${file.cloudPath}`);
    }
    const currentPrefix = fileID.slice(0, -file.cloudPath.length);
    if (prefix && prefix !== currentPrefix) throw new Error("同批次上传返回了不同的云存储桶");
    prefix = currentPrefix;
    console.log(`[${index + 1}/${uploads.length}] ${file.cloudPath}`);
  }
  fs.writeFileSync(configPath, `// Generated after all character assets are uploaded.\nmodule.exports = ${JSON.stringify(prefix)};\n`);
  console.log(`Upload complete. Cloud file prefix saved to ${path.relative(root, configPath)}.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

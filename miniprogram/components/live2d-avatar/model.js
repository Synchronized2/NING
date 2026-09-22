const modelData = require("../../assets/live2d/hiyori/model-data");
const { decompress, crc32 } = require("./lz4");

function loadModelBuffer() {
  // Package resources are JS modules, not readable USER_DATA_PATH files.
  const buffer = decompress(wx.base64ToArrayBuffer(modelData.data), modelData.size);
  if (crc32(buffer) !== modelData.crc32) throw new Error("内置人物模型校验失败，请重新编译小程序");
  return buffer;
}

module.exports = { loadModelBuffer };

const modelData = require("../../assets/live2d/hiyori/model-data");

function loadModelBuffer() {
  // Package resources are JS modules, not readable USER_DATA_PATH files.
  return wx.base64ToArrayBuffer(modelData);
}

module.exports = { loadModelBuffer };

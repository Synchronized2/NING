function decompress(buffer, size) {
  const source = new Uint8Array(buffer);
  const output = new Uint8Array(size);
  let input = 0;
  let written = 0;
  const length = (initial) => {
    let count = initial;
    if (initial === 15) {
      let extra;
      do {
        if (input >= source.length) throw new Error("人物模型压缩数据不完整");
        extra = source[input++];
        count += extra;
      } while (extra === 255);
    }
    return count;
  };
  while (input < source.length) {
    const token = source[input++];
    const literalCount = length(token >> 4);
    if (input + literalCount > source.length || written + literalCount > size) throw new Error("人物模型数据越界");
    output.set(source.subarray(input, input + literalCount), written);
    input += literalCount;
    written += literalCount;
    if (input === source.length) break;
    if (input + 2 > source.length) throw new Error("人物模型压缩数据不完整");
    const offset = source[input++] | source[input++] << 8;
    const matchCount = length(token & 15) + 4;
    if (!offset || offset > written || written + matchCount > size) throw new Error("人物模型数据越界");
    for (let index = 0; index < matchCount; index++) output[written + index] = output[written + index - offset];
    written += matchCount;
  }
  if (written !== size) throw new Error("人物模型解压长度不匹配");
  return output.buffer;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  const bytes = new Uint8Array(buffer);
  let value = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) value = (value >>> 8) ^ crcTable[(value ^ bytes[index]) & 255];
  return (value ^ 0xffffffff) >>> 0;
}

module.exports = { decompress, crc32 };

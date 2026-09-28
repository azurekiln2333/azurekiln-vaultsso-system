const crypto = require('node:crypto');
const { PNG } = require('pngjs');

const GLYPHS = {
  a: [14,17,17,31,17,17,17], b: [30,17,17,30,17,17,30], c: [14,17,16,16,16,17,14],
  d: [30,17,17,17,17,17,30], e: [31,16,16,30,16,16,31], f: [31,16,16,30,16,16,16],
  g: [14,17,16,23,17,17,14], h: [17,17,17,31,17,17,17], j: [7,2,2,2,18,18,12],
  k: [17,18,20,24,20,18,17], m: [17,27,21,21,17,17,17], n: [17,25,25,21,19,19,17],
  p: [30,17,17,30,16,16,16], q: [14,17,17,17,21,18,13], r: [30,17,17,30,20,18,17],
  s: [15,16,16,14,1,1,30], t: [31,4,4,4,4,4,4], u: [17,17,17,17,17,17,14],
  v: [17,17,17,17,17,10,4], w: [17,17,17,21,21,21,10], x: [17,17,10,4,10,17,17],
  y: [17,17,10,4,4,4,4], z: [31,1,2,4,8,16,31],
  2: [14,17,1,2,4,8,31], 3: [30,1,1,14,1,1,30], 4: [2,6,10,18,31,2,2],
  5: [31,16,16,30,1,1,30], 6: [14,16,16,30,17,17,14], 7: [31,1,2,4,8,8,8],
  8: [14,17,17,14,17,17,14], 9: [14,17,17,15,1,1,14]
};

function renderCaptcha(text) {
  const png = new PNG({ width: 200, height: 70 });
  function pixel(x, y, r, g, b) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= png.width || y < 0 || y >= png.height) return;
    const offset = (y * png.width + x) * 4;
    png.data[offset] = r; png.data[offset + 1] = g; png.data[offset + 2] = b; png.data[offset + 3] = 255;
  }
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) pixel(x, y, 244, 247, 255);
  for (let index = 0; index < text.length; index++) {
    const glyph = GLYPHS[text[index].toLowerCase()];
    if (!glyph) throw new Error('Unsupported CAPTCHA character');
    const left = 22 + index * 41 + crypto.randomInt(-3, 4);
    const top = 14 + crypto.randomInt(-4, 5);
    const skew = crypto.randomInt(-20, 21) / 100;
    for (let row = 0; row < 7; row++) for (let column = 0; column < 5; column++) {
      if (!(glyph[row] & (1 << (4 - column)))) continue;
      for (let dy = 0; dy < 5; dy++) for (let dx = 0; dx < 5; dx++) {
        const y = row * 5 + dy;
        pixel(left + column * 5 + dx + y * skew + Math.sin(y / 9) * 2, top + y, 15, 65, 145);
      }
    }
  }
  for (let index = 0; index < 160; index++) pixel(crypto.randomInt(200), crypto.randomInt(70), 110, 150, 200);
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}

module.exports = { renderCaptcha };

// 修复验证：多视口下滑杆可见性 + 拖动联动（firefox/chromium）
import { chromium, firefox } from 'playwright';

const browserName = process.argv[2] || 'firefox';
const browser = await (browserName === 'firefox' ? firefox : chromium).launch();

for (const vh of [900, 650, 600, 500]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: vh } });
  await page.goto('http://localhost:7999/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'admin', password: '123456' }),
    });
    localStorage.setItem('myagent_token', (await r.json()).token);
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.locator('button.settings-btn').click();
  await page.waitForTimeout(500);

  const slider = page.locator('input.thinking-slider');
  const n = await slider.count();
  if (!n) { console.log(`${browserName} vh=${vh}: NO SLIDER`); await page.close(); continue; }

  // 1) 几何与命中
  const geo = await page.evaluate(() => {
    const s = document.querySelector('input.thinking-slider');
    const r = s.getBoundingClientRect();
    const content = document.querySelector('.settings-content');
    const cr = content.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      sliderRect: { y: Math.round(r.y), h: Math.round(r.height), bottom: Math.round(r.bottom) },
      inContentArea: r.bottom <= cr.bottom - 2,
      inViewport: r.bottom <= window.innerHeight,
      hitByElementFromPoint: hit === s,
      hitIs: hit ? hit.tagName + '.' + ((hit.className && hit.className.baseVal !== undefined) ? hit.className.baseVal : hit.className || '') : null,
      contentScroll: { clientHeight: content.clientHeight, scrollHeight: content.scrollHeight, scrollTop: content.scrollTop },
      groupHeight: Math.round(document.querySelector('.thinking-slider-group').getBoundingClientRect().height),
      groupBottom: Math.round(document.querySelector('.thinking-slider-group').getBoundingClientRect().bottom),
    };
  });

  // 2) 拖动联动：鼠标拖到最右
  const b = await slider.boundingBox();
  let labelAfter = null, sliderValueAfter = null, ok = false;
  if (b && b.width > 0) {
    await page.mouse.move(b.x + b.width - 4, b.y + b.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.move(b.x + b.width - 4, b.y + b.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    labelAfter = await page.evaluate(() => {
      const g = document.querySelector('.thinking-slider-group');
      const lbl = g ? [...g.querySelectorAll('label')].find((l) => l.textContent.includes('推理深度')) : null;
      return lbl ? lbl.textContent : null;
    });
    sliderValueAfter = await slider.evaluate((el) => ({ value: el.value, max: el.max }));
    // 拖到最右后 value 应等于 max（xhigh）
    ok = sliderValueAfter && parseInt(sliderValueAfter.value) === parseInt(sliderValueAfter.max);
  }

  console.log(`${browserName} vh=${vh}:`, JSON.stringify({ ...geo, drag: { labelAfter, value: sliderValueAfter && sliderValueAfter.value, max: sliderValueAfter && sliderValueAfter.max, labelChangedToHighest: ok } }));
  await page.close();
}
await browser.close();

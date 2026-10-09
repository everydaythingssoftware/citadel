const {scenario, scroll} = window.__listCheck;
const rect = scroll.getBoundingClientRect();
const header = document.querySelector(scenario.header);
const footer = document.querySelector(scenario.footer);
return {
  scrollTop: scroll.scrollTop,
  scrollHeight: scroll.scrollHeight,
  viewport: {height:rect.height, width:rect.width, top:rect.top, bottom:rect.bottom},
  rows: [...document.querySelectorAll(scenario.rows)].map(row => {
    const bounds = row.getBoundingClientRect();
    const name = row.querySelector(scenario.name);
    const count = row.querySelector(scenario.count);
    const href = row.querySelector(scenario.link).getAttribute('href');
    return {name:name.textContent, count:Number(count.textContent), href,
      top:bounds.top, bottom:bounds.bottom, height:bounds.height,
      countRight:count.getBoundingClientRect().right};
  }),
  header: header?.getBoundingClientRect().toJSON() ?? null,
  footer: footer?.textContent ?? null,
  footerBounds: footer?.parentElement.getBoundingClientRect().toJSON() ?? null,
};

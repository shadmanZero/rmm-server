// Drive the REAL viewer (noVNC + stats sniffer) in headless Chrome against the
// local relay+agent, to reproduce the browser path my probes couldn't.
import puppeteer from "puppeteer-core";

const DEVICE = process.argv[2];
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = `http://localhost:4000/viewer.html?device=${DEVICE}&name=test&debug`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();

const logs = [];
page.on("console", (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
page.on("requestfailed", (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));

console.log("navigating:", URL);
await page.goto(URL, { waitUntil: "domcontentloaded" });

// Poll the viewer state pill + canvas for up to 12s.
let result = { state: "?", hasCanvas: false, canvas: null };
for (let i = 0; i < 24; i++) {
  result = await page.evaluate(() => {
    const pill = document.getElementById("viewer-state");
    const canvas = document.querySelector("#screen canvas");
    return {
      state: pill ? pill.textContent.trim() : "(no pill)",
      hasCanvas: !!canvas,
      canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
    };
  });
  if (result.state === "connected" || result.state === "connection lost") break;
  await new Promise((r) => setTimeout(r, 500));
}

console.log("FINAL STATE:", JSON.stringify(result));
console.log("=== browser console (last 40) ===");
console.log(logs.slice(-40).join("\n"));

await browser.close();
process.exit(0);

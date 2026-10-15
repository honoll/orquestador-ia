// agy falso para los tests del trabajador: imprime NDJSON como `agy --output-format stream-json`.
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", async () => {
  const prompt = JSON.parse(stdin.trim()).message.content;
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  out({ event: "init", cwd: process.cwd() });
  if (prompt === "LENTO") await new Promise((r) => setTimeout(r, 30_000));
  out({ event: "step_update", text: "pensando" });
  out({
    event: "result",
    args: process.argv.slice(2),
    prompt,
    secretVisible: "TYPESAFE_API_KEY" in process.env,
  });
  process.exitCode = prompt === "FALLA" ? 3 : 0;
});

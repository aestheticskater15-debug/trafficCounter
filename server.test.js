const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Readable } = require("node:stream");
const test = require("node:test");
const vm = require("node:vm");

function loadServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "traffic-counter-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "data", "devices"), { recursive: true });
  const context = vm.createContext({
    require: name => name === "serialport"
      ? { SerialPort: { list: async () => [{ path: "COM4" }] } }
      : require(name),
    __dirname: directory,
    process,
    console,
    Buffer
  });
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  vm.runInContext(source.slice(0, source.indexOf("const server = http.createServer")), context);
  return {
    directory,
    context,
    run: expression => vm.runInContext(expression, context)
  };
}

test("existing CSV history is migrated and keeps the same filename after restart", t => {
  const server = loadServer(t);
  const dataDirectory = path.join(server.directory, "data");
  const csvDirectory = path.join(dataDirectory, "devices");
  const devices = [
    { id: "andy-id", name: "Andy's device", portPath: null },
    { id: "raina-id", name: "raina", portPath: "COM4" }
  ];
  const history = "header\n7,7,2026-10-17,12:00:00,2026-10-17T12:00:00-07:00,100,42\n";
  fs.writeFileSync(path.join(dataDirectory, "devices.json"), JSON.stringify(devices));
  for (const device of devices) {
    fs.writeFileSync(path.join(csvDirectory, `${device.id}.csv`), history);
  }

  server.run("initializeData()");
  for (const device of devices) {
    assert.equal(fs.readFileSync(path.join(csvDirectory, `${device.name}.csv`), "utf8"), history);
    assert.equal(fs.existsSync(path.join(csvDirectory, `${device.id}.csv`)), false);
  }
  assert.equal(server.run("deviceStates.get('raina-id').nextCrossingNumber"), 8);
  server.run("deviceStates.clear(); initializeData()");
  assert.equal(server.run("deviceStates.get('andy-id').csvFileName"), "Andy's device.csv");
  assert.equal(server.run("deviceStates.get('raina-id').recentPasses.length"), 1);
});

test("unsafe names, case-insensitive duplicates, and existing files stay separate", t => {
  const server = loadServer(t);
  const csvDirectory = path.join(server.directory, "data", "devices");
  fs.writeFileSync(path.join(csvDirectory, "Taken.csv"), "unrelated history");
  const names = ["raina", "RAINA", "bad:/name? ", "CON", "...", "Taken"];
  for (const name of names) {
    server.context.deviceName = name;
    server.run("createVirtualDevice(deviceName, 'import')");
  }
  const filenames = server.run("[...deviceStates.values()].map(state => state.csvFileName)");
  assert.deepEqual(Array.from(filenames), [
    "raina.csv", "RAINA (2).csv", "bad__name_.csv", "_CON.csv", "device.csv", "Taken (2).csv"
  ]);
  assert.equal(fs.readFileSync(path.join(csvDirectory, "Taken.csv"), "utf8"), "unrelated history");
});

test("serial registration ignores null ports and rejects duplicate ports", async t => {
  const server = loadServer(t);
  server.run("createVirtualDevice('Demo', 'demo')");
  server.context.request = () => Readable.from([JSON.stringify({ name: "Raina", portPath: "com4" })]);
  const state = await server.run("addDevice(request())");
  assert.equal(state.csvFileName, "Raina.csv");
  await assert.rejects(server.run("addDevice(request())"), error => error.statusCode === 409);
});

test("serial passes and imports append to the named file used by analytics", t => {
  const server = loadServer(t);
  server.run(`
    const state = createVirtualDevice('Raina', 'import');
    processSerialLine(state, 'PASS,count,1,elapsed,100,42');
    appendImportedRecords(state, [{
      arduinoCount: 2, date: '2026-10-17', time: '12:00:00',
      timestamp: '2026-10-17T12:00:00-07:00', elapsedMilliseconds: 200, peak: 43
    }]);
  `);
  const csv = fs.readFileSync(path.join(server.directory, "data", "devices", "Raina.csv"), "utf8");
  assert.equal(csv.trim().split("\n").length, 3);
  assert.equal(server.run("readDeviceTimestamps(state).length"), 2);
});

test("downloads include the device filename and support Unicode names", async t => {
  const server = loadServer(t);
  const state = server.run("createVirtualDevice('Rain\\u00e1', 'import')");
  const response = new PassThrough();
  let headers;
  response.writeHead = (status, value) => {
    assert.equal(status, 200);
    headers = value;
  };
  let body = "";
  response.setEncoding("utf8");
  response.on("data", chunk => { body += chunk; });
  const completed = new Promise((resolve, reject) => {
    response.on("end", resolve);
    response.on("error", reject);
  });
  server.context.response = response;
  await server.run(`handleApiRequest(
    { method: 'GET' }, response,
    { pathname: '/api/devices/${state.id}/csv' }
  )`);
  await completed;
  assert.equal(headers["Content-Disposition"],
    "attachment; filename=\"Rain_.csv\"; filename*=UTF-8''Rain%C3%A1.csv");
  assert.match(body, /^Crossing number,Arduino count,/);
});

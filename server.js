const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { SerialPort, ReadlineParser } = require("serialport");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIRECTORY = path.join(__dirname, "data");
const DEVICE_DATA_DIRECTORY = path.join(DATA_DIRECTORY, "devices");
const DEVICES_PATH = path.join(DATA_DIRECTORY, "devices.json");
const CSV_HEADER =
  "Crossing number,Arduino count,Date (GMT-7),Time (GMT-7)," +
  "Timestamp (GMT-7),Arduino elapsed (ms),Peak\n";
const MAX_RECENT_PASSES = 1000;
const RANGE_CONFIG = {
  "1h": { duration: 60 * 60 * 1000, buckets: 12 },
  "4h": { duration: 4 * 60 * 60 * 1000, buckets: 12 },
  "24h": { duration: 24 * 60 * 60 * 1000, buckets: 12 },
  "2d": { duration: 2 * 24 * 60 * 60 * 1000, buckets: 12 },
  "3d": { duration: 3 * 24 * 60 * 60 * 1000, buckets: 12 },
  "7d": { duration: 7 * 24 * 60 * 60 * 1000, buckets: 14 },
  "10d": { duration: 10 * 24 * 60 * 60 * 1000, buckets: 10 },
  "15d": { duration: 15 * 24 * 60 * 60 * 1000, buckets: 15 },
  "1mo": { duration: 30 * 24 * 60 * 60 * 1000, buckets: 15 }
};
const deviceStates = new Map();
const eventClients = new Set();

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function formatGmtMinus7(date) {
  const shifted = new Date(date.getTime() - 7 * 60 * 60 * 1000);
  const datePart = [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0")
  ].join("-");
  const timePart = [
    String(shifted.getUTCHours()).padStart(2, "0"),
    String(shifted.getUTCMinutes()).padStart(2, "0"),
    String(shifted.getUTCSeconds()).padStart(2, "0")
  ].join(":");

  return {
    date: datePart,
    time: timePart,
    timestamp: `${datePart}T${timePart}-07:00`
  };
}

function csvPathFor(state) {
  return path.join(DEVICE_DATA_DIRECTORY, state.csvFileName);
}

function assignCsvFileName(state) {
  if (state.csvFileName) return;

  let baseName = state.name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "");
  if (!baseName) baseName = "device";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(baseName)) {
    baseName = `_${baseName}`;
  }

  const assignedNames = new Set(
    [...deviceStates.values()]
      .filter(device => device.id !== state.id && device.csvFileName)
      .map(device => device.csvFileName.toLowerCase())
  );
  let fileName = `${baseName}.csv`;
  let suffix = 2;
  while (
    assignedNames.has(fileName.toLowerCase()) ||
    fs.existsSync(path.join(DEVICE_DATA_DIRECTORY, fileName))
  ) {
    fileName = `${baseName} (${suffix++}).csv`;
  }
  state.csvFileName = fileName;
}

function publicDevice(state) {
  return {
    id: state.id,
    name: state.name,
    portPath: state.portPath,
    source: state.source,
    connected: Boolean(state.serialPort?.isOpen)
  };
}

function statusPayload(state, message) {
  return {
    deviceId: state.id,
    connected: Boolean(state.serialPort?.isOpen),
    port: state.portPath,
    message
  };
}

function persistDevices() {
  const devices = [...deviceStates.values()].map(({
    id,
    name,
    portPath,
    source,
    csvFileName
  }) => ({
    id,
    name,
    portPath,
    source,
    csvFileName
  }));
  const temporaryPath = `${DEVICES_PATH}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(devices, null, 2), "utf8");
  fs.renameSync(temporaryPath, DEVICES_PATH);
}

function initializeDeviceCsv(state) {
  assignCsvFileName(state);
  const csvPath = csvPathFor(state);
  const legacyPath = path.join(DEVICE_DATA_DIRECTORY, `${state.id}.csv`);
  if (fs.existsSync(legacyPath) && legacyPath !== csvPath) {
    if (fs.existsSync(csvPath)) {
      throw new Error(`Both legacy and named CSV files exist for ${state.name}.`);
    }
    fs.renameSync(legacyPath, csvPath);
  }
  if (!fs.existsSync(csvPath) || fs.statSync(csvPath).size === 0) {
    fs.writeFileSync(csvPath, CSV_HEADER, "utf8");
    return;
  }

  const lines = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
  for (const line of lines.slice(1)) {
    const fields = line.split(",");
    const crossingNumber = Number(fields[0]);
    const timestamp = fields[4];
    if (!Number.isFinite(crossingNumber) || !timestamp) continue;

    state.nextCrossingNumber = Math.max(
      state.nextCrossingNumber,
      crossingNumber + 1
    );
    state.recentPasses.push({
      deviceId: state.id,
      crossingNumber,
      arduinoCount: Number(fields[1]),
      date: fields[2],
      time: fields[3],
      timestamp,
      elapsedMilliseconds: Number(fields[5]),
      peak: Number(fields[6])
    });
  }

  if (state.recentPasses.length > MAX_RECENT_PASSES) {
    state.recentPasses.splice(
      0,
      state.recentPasses.length - MAX_RECENT_PASSES
    );
  }
}

function initializeData() {
  fs.mkdirSync(DEVICE_DATA_DIRECTORY, { recursive: true });
  if (!fs.existsSync(DEVICES_PATH)) {
    fs.writeFileSync(DEVICES_PATH, "[]\n", "utf8");
  }

  const devices = JSON.parse(fs.readFileSync(DEVICES_PATH, "utf8"));
  if (!Array.isArray(devices)) {
    throw new Error("data/devices.json must contain an array.");
  }

  for (const device of devices) {
    if (
      typeof device.id !== "string" ||
      typeof device.name !== "string" ||
      (
        device.csvFileName !== undefined &&
        (
          typeof device.csvFileName !== "string" ||
          !device.csvFileName.endsWith(".csv") ||
          /[<>:"/\\|?*\x00-\x1f]/.test(device.csvFileName)
        )
      ) ||
      !(
        typeof device.portPath === "string" ||
        device.portPath === null
      )
    ) {
      throw new Error("data/devices.json contains an invalid device.");
    }

    const state = {
      id: device.id,
      name: device.name,
      portPath: device.portPath,
      source: device.source ?? (device.portPath ? "serial" : "import"),
      csvFileName: device.csvFileName,
      serialPort: undefined,
      recentPasses: [],
      nextCrossingNumber: 1
    };
    deviceStates.set(state.id, state);
  }
  for (const state of deviceStates.values()) assignCsvFileName(state);
  persistDevices();
  for (const state of deviceStates.values()) initializeDeviceCsv(state);
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function broadcast(type, value) {
  const message = `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
  for (const client of eventClients) client.write(message);
}

function processSerialLine(state, line) {
  const fields = line.trim().split(",");
  if (fields[0] !== "PASS" || fields.length < 6) return;

  const arduinoCount = Number(fields[2]);
  const elapsedMilliseconds = Number(fields[4]);
  const peak = Number(fields[5]);
  if (
    !Number.isFinite(arduinoCount) ||
    !Number.isFinite(elapsedMilliseconds) ||
    !Number.isFinite(peak)
  ) {
    broadcast(
      "device-status",
      statusPayload(state, "Ignored an invalid PASS record")
    );
    return;
  }

  const detectedAt = formatGmtMinus7(new Date());
  const crossing = {
    deviceId: state.id,
    crossingNumber: state.nextCrossingNumber++,
    arduinoCount,
    date: detectedAt.date,
    time: detectedAt.time,
    timestamp: detectedAt.timestamp,
    elapsedMilliseconds,
    peak
  };
  const row = [
    crossing.crossingNumber,
    crossing.arduinoCount,
    crossing.date,
    crossing.time,
    crossing.timestamp,
    crossing.elapsedMilliseconds,
    crossing.peak
  ].join(",");

  fs.appendFileSync(csvPathFor(state), `${row}\n`, "utf8");
  state.recentPasses.push(crossing);
  if (state.recentPasses.length > MAX_RECENT_PASSES) {
    state.recentPasses.shift();
  }
  broadcast("crossing", crossing);
  broadcast(
    "device-status",
    statusPayload(
      state,
      `Connected - saved crossing ${crossing.crossingNumber}`
    )
  );
}

async function connectSerial(state) {
  if (!state.portPath) {
    throw new HttpError(409, `${state.name} is an uploaded data device.`);
  }
  if (state.serialPort?.isOpen) {
    throw new HttpError(409, `${state.name} is already connected.`);
  }

  const conflictingState = [...deviceStates.values()].find(
    candidate =>
      candidate.id !== state.id &&
      candidate.serialPort?.isOpen &&
      candidate.portPath.toUpperCase() === state.portPath.toUpperCase()
  );
  if (conflictingState) {
    throw new HttpError(
      409,
      `${state.portPath} is already connected to ${conflictingState.name}.`
    );
  }

  const availablePorts = await SerialPort.list();
  if (
    !availablePorts.some(
      port => port.path.toUpperCase() === state.portPath.toUpperCase()
    )
  ) {
    throw new HttpError(
      409,
      `${state.portPath} is not available. Check the cable and refresh ports.`
    );
  }

  const candidate = new SerialPort({
    path: state.portPath,
    baudRate: 115200,
    autoOpen: false
  });
  await new Promise((resolve, reject) => {
    candidate.open(error => error ? reject(error) : resolve());
  });

  state.serialPort = candidate;
  const parser = candidate.pipe(new ReadlineParser({ delimiter: "\n" }));
  parser.on("data", line => processSerialLine(state, line));
  candidate.on("error", error => {
    broadcast(
      "device-status",
      statusPayload(state, `Arduino error: ${error.message}`)
    );
  });
  candidate.on("close", () => {
    state.serialPort = undefined;
    broadcast(
      "device-status",
      statusPayload(state, "Arduino disconnected")
    );
    broadcast("devices", [...deviceStates.values()].map(publicDevice));
  });
  broadcast(
    "device-status",
    statusPayload(state, `Connected to ${state.portPath}`)
  );
  broadcast("devices", [...deviceStates.values()].map(publicDevice));
}

async function disconnectSerial(state) {
  if (!state.serialPort?.isOpen) return;
  await new Promise((resolve, reject) => {
    state.serialPort.close(error => error ? reject(error) : resolve());
  });
}

function readRequestBody(request, maximumLength = 10_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => {
      body += chunk;
      if (body.length > maximumLength) {
        reject(new HttpError(413, "Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpError(400, "Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function requireDevice(deviceId) {
  const state = deviceStates.get(deviceId);
  if (!state) throw new HttpError(404, "Device not found.");
  return state;
}

async function addDevice(request) {
  const body = await readRequestBody(request);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const portPath =
    typeof body.portPath === "string" ? body.portPath.trim() : "";

  if (!name || name.length > 80) {
    throw new HttpError(400, "Device name must be 1 to 80 characters.");
  }
  if (!portPath || portPath.length > 100) {
    throw new HttpError(400, "A valid serial port is required.");
  }

  const availablePorts = await SerialPort.list();
  const matchedPort = availablePorts.find(
    port => port.path.toUpperCase() === portPath.toUpperCase()
  );
  if (!matchedPort) {
    throw new HttpError(409, "The selected serial port is not available.");
  }
  if (
    [...deviceStates.values()].some(
      state => state.portPath?.toUpperCase() === matchedPort.path.toUpperCase()
    )
  ) {
    throw new HttpError(409, "That serial port is already assigned.");
  }

  const state = {
    id: crypto.randomUUID(),
    name,
    portPath: matchedPort.path,
    source: "serial",
    serialPort: undefined,
    recentPasses: [],
    nextCrossingNumber: 1
  };
  deviceStates.set(state.id, state);
  initializeDeviceCsv(state);
  persistDevices();
  broadcast("devices", [...deviceStates.values()].map(publicDevice));
  return state;
}

function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(field.trim());
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new HttpError(400, "CSV contains an unclosed quote.");
  fields.push(field.trim());
  return fields;
}

function normalizeHeader(header) {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function findHeaderIndex(headers, names) {
  return headers.findIndex(header => names.includes(header));
}

function parseImportedCsv(csvText) {
  const lines = csvText.replace(/^\uFEFF/, "").split(/\r?\n/);
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length < 2) {
    throw new HttpError(400, "CSV must contain a header and at least one row.");
  }
  if (lines.length > 100_001) {
    throw new HttpError(400, "CSV cannot contain more than 100,000 rows.");
  }

  const headers = parseCsvLine(lines[0]).map(normalizeHeader);
  const timestampIndex = findHeaderIndex(headers, [
    "timestamp",
    "timestamp gmt 7",
    "detected at"
  ]);
  const dateIndex = findHeaderIndex(headers, ["date", "date gmt 7"]);
  const timeIndex = findHeaderIndex(headers, ["time", "time gmt 7"]);
  const arduinoCountIndex = findHeaderIndex(headers, [
    "arduino count",
    "total count",
    "count"
  ]);
  const elapsedIndex = findHeaderIndex(headers, [
    "arduino elapsed ms",
    "elapsed milliseconds",
    "elapsed ms"
  ]);
  const peakIndex = findHeaderIndex(headers, ["peak"]);

  if (timestampIndex < 0 && (dateIndex < 0 || timeIndex < 0)) {
    throw new HttpError(
      400,
      "CSV needs a timestamp column or separate date and time columns."
    );
  }

  const records = [];
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
    if (!lines[lineIndex].trim()) continue;
    const fields = parseCsvLine(lines[lineIndex]);
    const timestampText = timestampIndex >= 0
      ? fields[timestampIndex]
      : `${fields[dateIndex]}T${fields[timeIndex]}-07:00`;
    const detectedAt = new Date(timestampText);
    if (!Number.isFinite(detectedAt.getTime())) {
      throw new HttpError(
        400,
        `CSV row ${lineIndex + 1} has an invalid date or timestamp.`
      );
    }

    const parsedTime = formatGmtMinus7(detectedAt);
    const numericValue = (index, fallback) => {
      if (index < 0 || fields[index] === "") return fallback;
      const value = Number(fields[index]);
      if (!Number.isFinite(value)) {
        throw new HttpError(
          400,
          `CSV row ${lineIndex + 1} contains an invalid number.`
        );
      }
      return value;
    };

    records.push({
      arduinoCount: numericValue(arduinoCountIndex, records.length + 1),
      date: parsedTime.date,
      time: parsedTime.time,
      timestamp: parsedTime.timestamp,
      elapsedMilliseconds: numericValue(elapsedIndex, 0),
      peak: numericValue(peakIndex, 0)
    });
  }

  if (records.length === 0) {
    throw new HttpError(400, "CSV does not contain any data rows.");
  }
  return records;
}

function createVirtualDevice(name, source) {
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName || trimmedName.length > 80) {
    throw new HttpError(400, "Device name must be 1 to 80 characters.");
  }

  const state = {
    id: crypto.randomUUID(),
    name: trimmedName,
    portPath: null,
    source,
    serialPort: undefined,
    recentPasses: [],
    nextCrossingNumber: 1
  };
  deviceStates.set(state.id, state);
  initializeDeviceCsv(state);
  return state;
}

function appendImportedRecords(state, records) {
  const rows = [];
  const crossings = records.map(record => {
    const crossing = {
      deviceId: state.id,
      crossingNumber: state.nextCrossingNumber++,
      ...record
    };
    rows.push([
      crossing.crossingNumber,
      crossing.arduinoCount,
      crossing.date,
      crossing.time,
      crossing.timestamp,
      crossing.elapsedMilliseconds,
      crossing.peak
    ].join(","));
    return crossing;
  });

  fs.appendFileSync(csvPathFor(state), `${rows.join("\n")}\n`, "utf8");
  state.recentPasses.push(...crossings);
  state.recentPasses.sort(
    (left, right) => new Date(left.timestamp) - new Date(right.timestamp)
  );
  if (state.recentPasses.length > MAX_RECENT_PASSES) {
    state.recentPasses.splice(
      0,
      state.recentPasses.length - MAX_RECENT_PASSES
    );
  }
}

async function importCsv(request) {
  const body = await readRequestBody(request, 10_000_000);
  if (typeof body.csvText !== "string") {
    throw new HttpError(400, "CSV file content is required.");
  }

  const records = parseImportedCsv(body.csvText);
  let state;
  let created = false;
  if (typeof body.deviceId === "string" && body.deviceId) {
    state = requireDevice(body.deviceId);
  } else {
    state = createVirtualDevice(body.newDeviceName, "import");
    created = true;
  }

  try {
    appendImportedRecords(state, records);
    if (created) persistDevices();
  } catch (error) {
    if (created) {
      deviceStates.delete(state.id);
      fs.rmSync(csvPathFor(state), { force: true });
    }
    throw error;
  }

  broadcast("devices", [...deviceStates.values()].map(publicDevice));
  return { device: publicDevice(state), importedRows: records.length };
}

function readDeviceTimestamps(state) {
  const lines = fs.readFileSync(csvPathFor(state), "utf8").split(/\r?\n/);
  const timestamps = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    const timestamp = new Date(fields[4]).getTime();
    if (Number.isFinite(timestamp)) timestamps.push(timestamp);
  }
  return timestamps;
}

function buildAnalytics(rangeKey, requestedDeviceIds) {
  const config = RANGE_CONFIG[rangeKey];
  if (!config) throw new HttpError(400, "Unsupported time range.");

  const now = Date.now();
  const start = now - config.duration;
  const bucketMilliseconds = config.duration / config.buckets;
  const ids = requestedDeviceIds.length > 0
    ? requestedDeviceIds
    : [...deviceStates.keys()];
  const devices = ids.map(requireDevice).map(state => {
    const counts = Array(config.buckets).fill(0);
    for (const timestamp of readDeviceTimestamps(state)) {
      if (timestamp < start || timestamp > now) continue;
      const index = Math.min(
        Math.floor((timestamp - start) / bucketMilliseconds),
        config.buckets - 1
      );
      counts[index]++;
    }
    return {
      id: state.id,
      name: state.name,
      total: counts.reduce((sum, count) => sum + count, 0),
      counts
    };
  });

  return {
    range: rangeKey,
    start: new Date(start).toISOString(),
    end: new Date(now).toISOString(),
    bucketMilliseconds,
    bucketStarts: Array.from(
      { length: config.buckets },
      (_, index) => new Date(start + index * bucketMilliseconds).toISOString()
    ),
    devices
  };
}

function seedDemoData() {
  if (deviceStates.size > 0) return;

  const now = Date.now();
  const definitions = [
    { name: "North Gate Demo", morning: 8, evening: 4, offset: 0 },
    { name: "South Gate Demo", morning: 3, evening: 9, offset: 7 }
  ];

  for (const definition of definitions) {
    const state = createVirtualDevice(definition.name, "demo");
    const records = [];
    for (let hoursAgo = 30 * 24; hoursAgo >= 0; hoursAgo--) {
      const hourStart = now - (hoursAgo + 1) * 60 * 60 * 1000;
      const hour = new Date(hourStart - 7 * 60 * 60 * 1000).getUTCHours();
      const day = new Date(hourStart).getUTCDay();
      const rushCount =
        hour >= 6 && hour <= 10
          ? definition.morning
          : hour >= 15 && hour <= 19
            ? definition.evening
            : 1;
      const weekendFactor = day === 0 || day === 6 ? 0.55 : 1;
      const count = Math.max(
        0,
        Math.round(
          rushCount * weekendFactor +
          ((hoursAgo + definition.offset) % 3) - 1
        )
      );
      for (let index = 0; index < count; index++) {
        const detectedAt = new Date(
          hourStart + ((index + 1) * 60 * 60 * 1000) / (count + 1)
        );
        const formatted = formatGmtMinus7(detectedAt);
        records.push({
          arduinoCount: records.length + 1,
          date: formatted.date,
          time: formatted.time,
          timestamp: formatted.timestamp,
          elapsedMilliseconds: records.length * 1000,
          peak: 3600 + ((records.length * 137 + definition.offset) % 2400)
        });
      }
    }
    appendImportedRecords(state, records);
  }
  persistDevices();
}

async function handleApiRequest(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/ports") {
    const ports = await SerialPort.list();
    sendJson(response, 200, ports.map(port => ({
      path: port.path,
      manufacturer: port.manufacturer ?? null
    })));
    return true;
  }

  if (url.pathname === "/api/devices" && request.method === "GET") {
    sendJson(response, 200, [...deviceStates.values()].map(publicDevice));
    return true;
  }

  if (url.pathname === "/api/devices" && request.method === "POST") {
    const state = await addDevice(request);
    sendJson(response, 201, publicDevice(state));
    return true;
  }

  if (url.pathname === "/api/import" && request.method === "POST") {
    const result = await importCsv(request);
    sendJson(response, 201, result);
    return true;
  }

  if (url.pathname === "/api/analytics" && request.method === "GET") {
    const rangeKey = url.searchParams.get("range") ?? "24h";
    const deviceIds = (url.searchParams.get("devices") ?? "")
      .split(",")
      .filter(Boolean);
    sendJson(response, 200, buildAnalytics(rangeKey, deviceIds));
    return true;
  }

  const match = url.pathname.match(
    /^\/api\/devices\/([0-9a-f-]+)(?:\/(passes|connect|disconnect|csv))?$/
  );
  if (!match) return false;

  const state = requireDevice(match[1]);
  const action = match[2];
  if (!action && request.method === "GET") {
    sendJson(response, 200, publicDevice(state));
    return true;
  }
  if (action === "passes" && request.method === "GET") {
    sendJson(response, 200, state.recentPasses);
    return true;
  }
  if (action === "connect" && request.method === "POST") {
    await connectSerial(state);
    sendJson(
      response,
      200,
      statusPayload(state, `Connected to ${state.portPath}`)
    );
    return true;
  }
  if (action === "disconnect" && request.method === "POST") {
    await disconnectSerial(state);
    sendJson(response, 200, statusPayload(state, "Arduino disconnected"));
    return true;
  }
  if (action === "csv" && request.method === "GET") {
    serveFile(
      response,
      csvPathFor(state),
      "text/csv; charset=utf-8",
      state.csvFileName
    );
    return true;
  }

  return false;
}

function serveFile(response, filePath, contentType, downloadName) {
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      sendJson(response, 404, { error: "File not found." });
      return;
    }

    const headers = {
      "Content-Type": contentType,
      "Content-Length": stats.size,
      "Cache-Control": "no-store"
    };
    if (downloadName) {
      const fallbackName = downloadName.replace(/[^\x20-\x7e]|["\\]/g, "_");
      const encodedName = encodeURIComponent(downloadName).replace(
        /['()*]/g,
        character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      );
      headers["Content-Disposition"] =
        `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`;
    }
    response.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(response);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (request.method === "GET" && url.pathname === "/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });
      response.write(": connected\n\n");
      eventClients.add(response);
      request.on("close", () => eventClients.delete(response));
      return;
    }

    if (await handleApiRequest(request, response, url)) return;

    if (
      request.method === "GET" &&
      url.pathname === "/assets/sensor-diagram.png"
    ) {
      serveFile(
        response,
        path.join(__dirname, "assets", "sensor-diagram.png"),
        "image/png"
      );
      return;
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/index.html")
    ) {
      serveFile(
        response,
        path.join(__dirname, "index.html"),
        "text/html; charset=utf-8"
      );
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    console.error(error);
    const statusCode =
      error instanceof HttpError ? error.statusCode : 500;
    if (!response.headersSent) {
      sendJson(response, statusCode, { error: error.message });
    } else {
      response.end();
    }
  }
});

initializeData();
seedDemoData();
server.listen(PORT, HOST, () => {
  console.log(`Traffic counter running at http://localhost:${PORT}`);
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        console.log(`Wi-Fi/LAN dashboard: http://${address.address}:${PORT}`);
      }
    }
  }
  console.log(`Device data: ${DEVICE_DATA_DIRECTORY}`);
});

async function shutDown() {
  try {
    await Promise.all(
      [...deviceStates.values()].map(state => disconnectSerial(state))
    );
  } finally {
    server.close(() => process.exit(0));
  }
}

process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);

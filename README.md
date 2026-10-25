# Traffic Counter Dashboard

This local server reads crossing events directly from multiple Arduinos, saves one complete CSV per device, and shows live dashboards to devices on the same Wi-Fi network.

## Arduino firmware

Open `arduino_counter/arduino_counter.ino` in Arduino IDE, select the connected board and COM port, and upload it. The `traffic_counter/traffic_counter.ino` copy has the same behavior. Choose **Disconnect** in the dashboard before uploading, close Serial Monitor/Plotter, then choose **Connect Arduino** afterward. Uploading or reconnecting can reset the Arduino's LCD count; saved CSV history is retained.

Each sensor trigger that increments the LCD count immediately sends one `PASS` record to the dashboard. The existing opposite-edge and timeout handling still controls when the detector can rearm, but does not send a second record. The CSV peak is the derivative magnitude at the initial trigger, not the maximum over the subsequent blocked interval. `CNT=` lines are diagnostic only and do not create dashboard crossings.

## Install Node.js on Windows

Node.js is required to run the dashboard. Install the current **LTS** version using either option below.

### Option 1: Download the installer

1. Open [Node.js](https://nodejs.org/).  
2. Download the **LTS** Windows installer.  
3. Run the installer and keep the default options selected.  
4. Close and reopen PowerShell after the installation finishes.

### Option 2: Install with WinGet

Open PowerShell and run:

```powershell
winget install OpenJS.NodeJS.LTS
```

&nbsp;

Close and reopen PowerShell, then verify the installation:

```powershell
node --version
npm --version
```

&nbsp;

Both commands should print a version number. `npm` is installed automatically with Node.js.

## Start

1. Connect the Arduino to this computer by USB.  
2. Open PowerShell in this folder.  
3. Run `npm install`.  
4. Run `npm start`.  
5. Open `http://localhost:3000` on this computer.  
6. Enter a device name, select its Arduino COM port, and choose **Add device**.  
7. Select the device card and choose **Connect Arduino**.

Repeat the registration steps for each additional Arduino. The home page shows one button for every registered device. Each button opens that device's live pass list and histograms.

Both views display the project title, "Optoelectronic Traffic Counter", and the credit "Andy Wang & Raina Ji" above the dashboard, with a compact, centered sensor diagram with a transparent background underneath and no image caption. On device dashboards, the local time and Arduino controls flank the image to keep the header compact; these sections stack on smaller screens.

The home page also includes:

- Named demo devices with mock historical data on a new installation.  
- Comparison totals and trend lines for 1 hour, 4 hours, 24 hours, 2 days, 3 days, 7 days, 10 days, 15 days, or 1 month.  
- Device selectors for comparing any combination of devices.  
- CSV upload into an existing device or a newly named imported-data device.

Uploaded CSV files need either a timestamp column or separate date and time columns. Arduino count, elapsed time, and peak columns are optional.

The terminal also prints a Wi-Fi/LAN URL such as `http://192.168.1.20:3000`. Open that address on phones or other computers on the same network. Keep the server terminal open while collecting data.

If Windows asks for network access, allow Node.js on private networks. The dashboard is only available while this computer is running the server.

Each device dashboard displays its latest 10 passes while its CSV retains the complete history. Use **Download this device's CSV** to download that history. Each device uses a separate CSV file and a stable internal device ID. CSV files in `data/devices` and downloaded CSVs use the device name, for example `Andy's device.csv` or `raina.csv`. Characters that Windows does not allow in filenames are replaced with underscores. Duplicate filenames receive a numbered suffix so devices never share a data file. Existing ID-named CSVs are migrated automatically on startup without changing their contents.
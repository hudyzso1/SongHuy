const screenshot = require("screenshot-desktop");

const API_URL =
    process.env.CYBERNET_API_URL ||
    "https://kdp4o8qcb1.execute-api.ap-southeast-1.amazonaws.com";

const USERNAME =
    String(process.env.CYBERNET_USERNAME || "huydz").trim().toLowerCase();

const MACHINE_NAME =
    String(process.env.CYBERNET_MACHINE || USERNAME.toUpperCase()).trim().toUpperCase();

const INTERVAL_MS = Number(process.env.CYBERNET_SCREEN_INTERVAL || 5000);

let uploading = false;
let lastDisabledLogAt = 0;

async function isScreenEnabled() {
    try {
        const res = await fetch(`${API_URL}/api/machines/${encodeURIComponent(USERNAME)}`);
        const data = await res.json().catch(() => ({}));

        const machine =
            data.machine ||
            data.item ||
            data.user ||
            data.data ||
            data;

        if (
            machine &&
            (
                machine.screenEnabled === false ||
                machine.screenEnabled === "false"
            )
        ) {
            return false;
        }

        return true;
    } catch {
        return true;
    }
}

async function uploadScreen() {
    if (uploading) return;

    const enabled = await isScreenEnabled();

    if (!enabled) {
        const now = Date.now();

        if (now - lastDisabledLogAt > 15000) {
            console.log(`[AWS SCREEN] ${MACHINE_NAME} đang bị admin tắt, ngừng upload...`);
            lastDisabledLogAt = now;
        }

        return;
    }

    uploading = true;

    try {
        const imgBuffer = await screenshot({
            format: "jpg"
        });

        const imageData = "data:image/jpeg;base64," + imgBuffer.toString("base64");

        const res = await fetch(`${API_URL}/api/client-upload-screen`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                username: USERNAME,
                machineName: MACHINE_NAME,
                imageData
            })
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok || !data.success) {
            console.log("[AWS SCREEN] Upload failed:", data);
            return;
        }

        console.log(`[AWS SCREEN] Uploaded ${MACHINE_NAME} -> ${data.screenKey} at ${new Date().toLocaleTimeString()}`);
    } catch (err) {
        console.log("[AWS SCREEN] Error:", err.message);
    } finally {
        uploading = false;
    }
}

console.log("CyberNet Edge Screen Agent started");
console.log("API:", API_URL);
console.log("Machine:", MACHINE_NAME);
console.log("Interval:", INTERVAL_MS + "ms");

uploadScreen();
setInterval(uploadScreen, INTERVAL_MS);

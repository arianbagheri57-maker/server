const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { spawn, execFile } = require("child_process");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MC_PORT = Number(process.env.MC_PORT || 25565);
const DATA_DIR = process.env.DATA_DIR || "/data";

const SERVER_DIR = path.join(DATA_DIR, "server");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const DB_FILE = path.join(DATA_DIR, "panel.json");

fs.mkdirSync(SERVER_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

app.use(express.json({ limit: "2mb" }));

/* =========================================================
   DATABASE
========================================================= */

function loadDB() {
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    } catch {
        return {
            users: [],
            server: null,
            settings: {
                maxPlayers: 20,
                difficulty: "normal",
                gamemode: "survival",
                pvp: true,
                whitelist: false,
                onlineMode: true,
                viewDistance: 10,
                simulationDistance: 10,
                motd: "Minecraft Server"
            }
        };
    }
}

let db = loadDB();

function saveDB() {
    fs.writeFileSync(
        DB_FILE,
        JSON.stringify(db, null, 2)
    );
}

function hash(value) {
    return crypto
        .createHash("sha256")
        .update(String(value))
        .digest("hex");
}

function randomId() {
    return crypto.randomBytes(24).toString("hex");
}

/* =========================================================
   DEFAULT ADMIN
========================================================= */

const ADMIN_USER =
    process.env.ADMIN_USER || "admin";

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD || "change-me-now";

if (!db.users.length) {
    db.users.push({
        id: "owner",
        username: ADMIN_USER,
        password: hash(ADMIN_PASSWORD),
        role: "owner",
        createdAt: Date.now()
    });

    saveDB();

    console.log(
        `Created owner account: ${ADMIN_USER}`
    );
}

/* =========================================================
   SESSION
========================================================= */

const sessions = new Map();

function getSession(req) {
    const id = req.headers["x-session"];

    if (!id) {
        return null;
    }

    return sessions.get(id) || null;
}

function requireAuth(req, res, next) {
    const user = getSession(req);

    if (!user) {
        return res
            .status(401)
            .json({ error: "Authentication required" });
    }

    req.user = user;
    next();
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res
                .status(403)
                .json({ error: "Permission denied" });
        }

        next();
    };
}

/* =========================================================
   LOGGING
========================================================= */

const logs = [];

function log(message) {
    const text = String(message);

    console.log(text);

    logs.push({
        time: Date.now(),
        text
    });

    if (logs.length > 1000) {
        logs.splice(0, logs.length - 1000);
    }
}

/* =========================================================
   MINECRAFT PROCESS
========================================================= */

let minecraftProcess = null;
let stopping = false;

function isRunning() {
    return !!minecraftProcess;
}

/* =========================================================
   HTTP DOWNLOAD
========================================================= */

function downloadFile(url, destination) {
    return new Promise((resolve, reject) => {
        const client =
            url.startsWith("https:")
                ? https
                : http;

        const request = client.get(
            url,
            {
                headers: {
                    "User-Agent":
                        "Railway-Minecraft-Panel/2.0"
                }
            },
            response => {

                if (
                    [301, 302, 303, 307, 308]
                        .includes(response.statusCode)
                    &&
                    response.headers.location
                ) {
                    response.resume();

                    return downloadFile(
                        new URL(
                            response.headers.location,
                            url
                        ).toString(),
                        destination
                    )
                        .then(resolve)
                        .catch(reject);
                }

                if (response.statusCode !== 200) {
                    response.resume();

                    return reject(
                        new Error(
                            `HTTP ${response.statusCode}`
                        )
                    );
                }

                const output =
                    fs.createWriteStream(destination);

                response.pipe(output);

                output.on("finish", () => {
                    output.close(resolve);
                });

                output.on("error", reject);
            }
        );

        request.on("error", reject);
    });
}

/* =========================================================
   JSON FETCH
========================================================= */

function fetchJSON(url) {
    return new Promise((resolve, reject) => {

        const client =
            url.startsWith("https:")
                ? https
                : http;

        const request = client.get(
            url,
            {
                headers: {
                    "User-Agent":
                        "Railway-Minecraft-Panel/2.0"
                }
            },
            response => {

                let body = "";

                response.on(
                    "data",
                    chunk => body += chunk
                );

                response.on("end", () => {

                    if (
                        response.statusCode < 200 ||
                        response.statusCode >= 300
                    ) {
                        return reject(
                            new Error(
                                `HTTP ${response.statusCode}`
                            )
                        );
                    }

                    try {
                        resolve(
                            JSON.parse(body)
                        );
                    } catch {
                        reject(
                            new Error(
                                "Invalid JSON response"
                            )
                        );
                    }
                });
            }
        );

        request.on("error", reject);
    });
}

/* =========================================================
   VERSION MANIFEST
========================================================= */

async function getMinecraftVersions() {

    const manifest = await fetchJSON(
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
    );

    return manifest.versions
        .filter(v => v.type === "release")
        .map(v => v.id);
}

/* =========================================================
   SERVER.PROPERTIES
========================================================= */

function readProperties() {

    const file =
        path.join(
            SERVER_DIR,
            "server.properties"
        );

    const result = {};

    if (!fs.existsSync(file)) {
        return result;
    }

    const content =
        fs.readFileSync(
            file,
            "utf8"
        );

    for (const line of content.split(/\r?\n/)) {

        if (
            !line ||
            line.startsWith("#") ||
            !line.includes("=")
        ) {
            continue;
        }

        const index =
            line.indexOf("=");

        const key =
            line.slice(0, index);

        const value =
            line.slice(index + 1);

        result[key] = value;
    }

    return result;
}

function writeProperties() {

    const file =
        path.join(
            SERVER_DIR,
            "server.properties"
        );

    const current =
        readProperties();

    const s = db.settings;

    current["server-port"] =
        String(MC_PORT);

    current["server-ip"] = "";

    current["max-players"] =
        String(s.maxPlayers);

    current["difficulty"] =
        s.difficulty;

    current["gamemode"] =
        s.gamemode;

    current["pvp"] =
        String(s.pvp);

    current["white-list"] =
        String(s.whitelist);

    current["online-mode"] =
        String(s.onlineMode);

    current["view-distance"] =
        String(s.viewDistance);

    current["simulation-distance"] =
        String(s.simulationDistance);

    current["motd"] =
        String(s.motd)
            .replace(/\r?\n/g, " ")
            .slice(0, 100);

    /*
      Minecraft versions that support this option
      can pause an empty server.

      -1 = never pause.
    */

    current["pause-when-empty-seconds"] = "-1";

    const output =
        Object.entries(current)
            .map(
                ([key, value]) =>
                    `${key}=${value}`
            )
            .join("\n") + "\n";

    fs.writeFileSync(
        file,
        output
    );
}

/* =========================================================
   EULA
========================================================= */

function acceptEula() {

    fs.writeFileSync(
        path.join(
            SERVER_DIR,
            "eula.txt"
        ),
        "eula=true\n"
    );
}

/* =========================================================
   VANILLA
========================================================= */

async function installVanilla(version) {

    log(
        `Installing Vanilla ${version}...`
    );

    const manifest =
        await fetchJSON(
            "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
        );

    const versionInfo =
        manifest.versions.find(
            v => v.id === version
        );

    if (!versionInfo) {
        throw new Error(
            `Minecraft ${version} not found`
        );
    }

    const metadata =
        await fetchJSON(
            versionInfo.url
        );

    if (
        !metadata.downloads ||
        !metadata.downloads.server
    ) {
        throw new Error(
            `No official server JAR for ${version}`
        );
    }

    const url =
        metadata.downloads.server.url;

    const destination =
        path.join(
            SERVER_DIR,
            "server.jar"
        );

    await downloadFile(
        url,
        destination
    );

    log(
        "Vanilla installation complete."
    );

    return {
        type: "vanilla",
        launch: [
            "-jar",
            "server.jar",
            "nogui"
        ]
    };
}

/* =========================================================
   FABRIC
========================================================= */

async function installFabric(version) {

    log(
        `Installing Fabric for ${version}...`
    );

    const loaders =
        await fetchJSON(
            `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}`
        );

    if (
        !Array.isArray(loaders) ||
        !loaders.length
    ) {
        throw new Error(
            `Fabric is not available for ${version}`
        );
    }

    const loader =
        loaders[0].loader.version;

    const installers =
        await fetchJSON(
            "https://meta.fabricmc.net/v2/versions/installer"
        );

    if (
        !Array.isArray(installers) ||
        !installers.length
    ) {
        throw new Error(
            "Fabric Installer unavailable"
        );
    }

    const installer =
        installers[0].version;

    const url =
        `https://meta.fabricmc.net/v2/versions/loader/` +
        `${encodeURIComponent(version)}/` +
        `${encodeURIComponent(loader)}/` +
        `${encodeURIComponent(installer)}/server/jar`;

    const destination =
        path.join(
            SERVER_DIR,
            "fabric-server.jar"
        );

    await downloadFile(
        url,
        destination
    );

    log(
        `Fabric Loader ${loader} installed.`
    );

    return {
        type: "fabric",
        launch: [
            "-jar",
            "fabric-server.jar",
            "nogui"
        ]
    };
}

/* =========================================================
   PAPER
========================================================= */

async function installPaper(version) {

    log(
        `Installing Paper ${version}...`
    );

    const project =
        await fetchJSON(
            `https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(version)}`
        );

    if (
        !project.builds ||
        !project.builds.length
    ) {
        throw new Error(
            `Paper is not available for ${version}`
        );
    }

    const build =
        project.builds[
            project.builds.length - 1
        ];

    const buildInfo =
        await fetchJSON(
            `https://api.papermc.io/v2/projects/paper/versions/` +
            `${encodeURIComponent(version)}/builds/${build}`
        );

    const file =
        buildInfo.downloads
            ?.application
            ?.name;

    if (!file) {
        throw new Error(
            "Paper JAR not found"
        );
    }

    const url =
        `https://api.papermc.io/v2/projects/paper/versions/` +
        `${encodeURIComponent(version)}/builds/${build}/downloads/` +
        `${encodeURIComponent(file)}`;

    await downloadFile(
        url,
        path.join(
            SERVER_DIR,
            "server.jar"
        )
    );

    log(
        `Paper build ${build} installed.`
    );

    return {
        type: "paper",
        launch: [
            "-jar",
            "server.jar",
            "nogui"
        ]
    };
}

/* =========================================================
   PURPUR
========================================================= */

async function installPurpur(version) {

    log(
        `Installing Purpur ${version}...`
    );

    const data =
        await fetchJSON(
            `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}`
        );

    const build =
        data.builds?.latest;

    if (!build) {
        throw new Error(
            `Purpur is not available for ${version}`
        );
    }

    const url =
        `https://api.purpurmc.org/v2/purpur/` +
        `${encodeURIComponent(version)}/${build}/download`;

    await downloadFile(
        url,
        path.join(
            SERVER_DIR,
            "server.jar"
        )
    );

    return {
        type: "purpur",
        launch: [
            "-jar",
            "server.jar",
            "nogui"
        ]
    };
}

/* =========================================================
   GENERIC FORGE INSTALLER
========================================================= */

async function runInstaller(jar) {

    return new Promise(
        (resolve, reject) => {

            log(
                "Running mod-loader installer..."
            );

            const child =
                spawn(
                    "java",
                    [
                        "-Xmx2G",
                        "-jar",
                        jar,
                        "--installServer"
                    ],
                    {
                        cwd: SERVER_DIR
                    }
                );

            child.stdout.on(
                "data",
                data => {
                    data
                        .toString()
                        .split(/\r?\n/)
                        .forEach(line => {
                            if (line.trim()) {
                                log(line);
                            }
                        });
                }
            );

            child.stderr.on(
                "data",
                data => {
                    data
                        .toString()
                        .split(/\r?\n/)
                        .forEach(line => {
                            if (line.trim()) {
                                log("[installer] " + line);
                            }
                        });
                }
            );

            child.on(
                "error",
                reject
            );

            child.on(
                "close",
                code => {

                    if (code === 0) {
                        resolve();
                    } else {
                        reject(
                            new Error(
                                `Installer exited with code ${code}`
                            )
                        );
                    }
                }
            );
        }
    );
}

/* =========================================================
   FORGE
========================================================= */

async function installForge(version) {

    log(
        `Looking for Forge ${version}...`
    );

    const promotions =
        await fetchJSON(
            "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json"
        );

    const recommended =
        promotions.promos?.[
            `${version}-recommended`
        ];

    const latest =
        promotions.promos?.[
            `${version}-latest`
        ];

    const forgeVersion =
        recommended || latest;

    if (!forgeVersion) {
        throw new Error(
            `Forge is not available for Minecraft ${version}`
        );
    }

    const filename =
        `forge-${version}-${forgeVersion}-installer.jar`;

    const url =
        `https://maven.minecraftforge.net/net/minecraftforge/forge/` +
        `${version}-${forgeVersion}/${filename}`;

    const installer =
        path.join(
            SERVER_DIR,
            "forge-installer.jar"
        );

    await downloadFile(
        url,
        installer
    );

    await runInstaller(
        "forge-installer.jar"
    );

    /*
      Forge versions don't all use the same
      startup layout. Prefer run.sh when generated.
    */

    const runSh =
        path.join(
            SERVER_DIR,
            "run.sh"
        );

    if (fs.existsSync(runSh)) {

        fs.chmodSync(
            runSh,
            0o755
        );

        return {
            type: "forge",
            shell: "./run.sh nogui"
        };
    }

    /*
      Older Forge installers can generate
      forge-version.jar.
    */

    const jars =
        fs.readdirSync(
            SERVER_DIR
        ).filter(
            file =>
                file.endsWith(".jar") &&
                file.startsWith("forge-")
        );

    const serverJar =
        jars.find(
            file =>
                !file.includes("installer")
        );

    if (!serverJar) {
        throw new Error(
            "Forge installed but no server launcher was found"
        );
    }

    return {
        type: "forge",
        launch: [
            "-jar",
            serverJar,
            "nogui"
        ]
    };
}

/* =========================================================
   NEOFORGE
========================================================= */

async function installNeoForge(version) {

    /*
      NeoForge has several loader releases for a
      Minecraft version. Instead of guessing an
      arbitrary loader, query Maven metadata.
    */

    log(
        `Looking for NeoForge for ${version}...`
    );

    const metadata =
        await fetch(
            "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml"
        ).then(r => r.text());

    const matches =
        [...metadata.matchAll(
            /<version>([^<]+)<\/version>/g
        )]
        .map(
            match => match[1]
        )
        .filter(
            v =>
                v.startsWith(
                    version + "."
                )
        );

    if (!matches.length) {
        throw new Error(
            `NeoForge is not available for Minecraft ${version}`
        );
    }

    const loaderVersion =
        matches[matches.length - 1];

    const installerName =
        `neoforge-${loaderVersion}-installer.jar`;

    const url =
        `https://maven.neoforged.net/releases/net/neoforged/neoforge/` +
        `${loaderVersion}/${installerName}`;

    const destination =
        path.join(
            SERVER_DIR,
            "neoforge-installer.jar"
        );

    await downloadFile(
        url,
        destination
    );

    await runInstaller(
        "neoforge-installer.jar"
    );

    const runSh =
        path.join(
            SERVER_DIR,
            "run.sh"
        );

    if (!fs.existsSync(runSh)) {
        throw new Error(
            "NeoForge installed but run.sh was not generated"
        );
    }

    fs.chmodSync(
        runSh,
        0o755
    );

    return {
        type: "neoforge",
        shell: "./run.sh nogui"
    };
}

/* =========================================================
   INSTALL DISPATCHER
========================================================= */

async function installServer(
    version,
    type
) {

    if (isRunning()) {
        throw new Error(
            "Stop the server before reinstalling"
        );
    }

    const normalized =
        String(type)
            .toLowerCase();

    switch (normalized) {

        case "vanilla":
            return installVanilla(version);

        case "fabric":
            return installFabric(version);

        case "paper":
            return installPaper(version);

        case "purpur":
            return installPurpur(version);

        case "forge":
            return installForge(version);

        case "neoforge":
            return installNeoForge(version);

        default:
            throw new Error(
                "Unsupported server type"
            );
    }
}

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {

    if (minecraftProcess) {
        return;
    }

    if (!db.server) {
        throw new Error(
            "No Minecraft server installed"
        );
    }

    acceptEula();

    /*
      IMPORTANT:
      Write properties immediately before starting
      Minecraft. This fixes the old Online Mode bug.
    */

    writeProperties();

    const ram =
        Math.max(
            512,
            Math.min(
                Number(db.server.ram || 2048),
                32768
            )
        );

    const javaArgs = [
        `-Xms${Math.min(ram, 1024)}M`,
        `-Xmx${ram}M`,
        "-XX:+UseG1GC",
        "-XX:+ParallelRefProcEnabled",
        "-Dfile.encoding=UTF-8"
    ];

    let child;

    if (db.server.shell) {

        const command =
            `exec ${db.server.shell}`;

        child =
            spawn(
                "sh",
                ["-lc", command],
                {
                    cwd: SERVER_DIR,
                    env: {
                        ...process.env,
                        JAVA_OPTS:
                            javaArgs.join(" "),
                        _JAVA_OPTIONS:
                            javaArgs.join(" ")
                    },
                    stdio: [
                        "pipe",
                        "pipe",
                        "pipe"
                    ]
                }
            );

    } else {

        child =
            spawn(
                "java",
                [
                    ...javaArgs,
                    ...(db.server.launch || [])
                ],
                {
                    cwd: SERVER_DIR,
                    env: process.env,
                    stdio: [
                        "pipe",
                        "pipe",
                        "pipe"
                    ]
                }
            );
    }

    minecraftProcess = child;
    stopping = false;

    log(
        "================================"
    );

    log(
        "Minecraft server starting..."
    );

    log(
        `RAM: ${ram} MB`
    );

    log(
        `Version: ${db.server.version}`
    );

    log(
        `Type: ${db.server.type}`
    );

    child.stdout.on(
        "data",
        data => {

            data
                .toString()
                .split(/\r?\n/)
                .forEach(line => {

                    if (line.trim()) {
                        log(line);
                    }

                });
        }
    );

    child.stderr.on(
        "data",
        data => {

            data
                .toString()
                .split(/\r?\n/)
                .forEach(line => {

                    if (line.trim()) {
                        log("[stderr] " + line);
                    }

                });
        }
    );

    child.on(
        "error",
        error => {

            log(
                "Minecraft process error: " +
                error.message
            );

            minecraftProcess = null;
        }
    );

    child.on(
        "close",
        code => {

            log(
                `Minecraft stopped. Exit code: ${code}`
            );

            minecraftProcess = null;
            stopping = false;
        }
    );
}

/* =========================================================
   STOP SERVER
========================================================= */

function stopServer() {

    if (!minecraftProcess) {
        return;
    }

    if (stopping) {
        return;
    }

    stopping = true;

    log(
        "Stopping Minecraft..."
    );

    try {
        minecraftProcess.stdin.write(
            "stop\n"
        );
    } catch {}

    setTimeout(() => {

        if (minecraftProcess) {

            log(
                "Minecraft did not stop gracefully. Terminating..."
            );

            try {
                minecraftProcess.kill(
                    "SIGTERM"
                );
            } catch {}

        }

    }, 15000);
}

/* =========================================================
   COMMAND
========================================================= */

function sendCommand(command) {

    if (!minecraftProcess) {
        throw new Error(
            "Minecraft server is offline"
        );
    }

    const clean =
        String(command)
            .trim();

    if (!clean) {
        return;
    }

    minecraftProcess.stdin.write(
        clean + "\n"
    );
}

/* =========================================================
   RAILWAY TCP ADDRESS
========================================================= */

function getMinecraftAddress() {

    const domain =
        process.env.RAILWAY_TCP_PROXY_DOMAIN;

    const port =
        process.env.RAILWAY_TCP_PROXY_PORT;

    if (!domain || !port) {
        return null;
    }

    return `${domain}:${port}`;
}

/* =========================================================
   API - LOGIN
========================================================= */

app.post(
    "/api/login",
    (req, res) => {

        const {
            username,
            password
        } = req.body || {};

        const user =
            db.users.find(
                u =>
                    u.username === username &&
                    u.password === hash(password || "")
            );

        if (!user) {

            return res
                .status(401)
                .json({
                    error:
                        "نام کاربری یا رمز عبور اشتباه است"
                });
        }

        const session =
            randomId();

        sessions.set(
            session,
            {
                id: user.id,
                username: user.username,
                role: user.role
            }
        );

        res.json({
            session,
            user: {
                username: user.username,
                role: user.role
            }
        });
    }
);

/* =========================================================
   API - LOGOUT
========================================================= */

app.post(
    "/api/logout",
    requireAuth,
    (req, res) => {

        const session =
            req.headers["x-session"];

        sessions.delete(session);

        res.json({
            ok: true
        });
    }
);

/* =========================================================
   API - STATE
========================================================= */

app.get(
    "/api/state",
    requireAuth,
    (req, res) => {

        res.json({
            user: req.user,

            server: db.server,

            settings:
                db.settings,

            status: {
                online:
                    isRunning(),

                version:
                    db.server?.version || null,

                type:
                    db.server?.type || null,

                ram:
                    db.server?.ram || null,

                address:
                    getMinecraftAddress()
            },

            logs:
                logs.slice(-200)
        });
    }
);

/* =========================================================
   API - VERSIONS
========================================================= */

app.get(
    "/api/versions",
    requireAuth,
    async (req, res) => {

        try {

            const versions =
                await getMinecraftVersions();

            res.json({
                versions
            });

        } catch (error) {

            res
                .status(500)
                .json({
                    error:
                        error.message
                });
        }
    }
);

/* =========================================================
   API - CREATE SERVER
========================================================= */

app.post(
    "/api/server/create",
    requireAuth,
    requireRole(
        "owner",
        "admin"
    ),
    async (req, res) => {

        try {

            const {
                version,
                type,
                ram,
                maxPlayers
            } = req.body;

            if (!version) {
                throw new Error(
                    "Minecraft version required"
                );
            }

            if (!type) {
                throw new Error(
                    "Server type required"
                );
            }

            const ramValue =
                Math.max(
                    512,
                    Math.min(
                        Number(ram || 2048),
                        32768
                    )
                );

            const result =
                await installServer(
                    version,
                    type
                );

            db.server = {
                version,
                type,
                ram: ramValue,
                launch:
                    result.launch || null,
                shell:
                    result.shell || null,
                createdAt:
                    Date.now()
            };

            if (maxPlayers) {
                db.settings.maxPlayers =
                    Math.max(
                        1,
                        Math.min(
                            Number(maxPlayers),
                            500
                        )
                    );
            }

            saveDB();

            writeProperties();

            res.json({
                ok: true,
                server: db.server
            });

        } catch (error) {

            log(
                "INSTALL ERROR: " +
                error.message
            );

            res
                .status(400)
                .json({
                    error:
                        error.message
                });
        }
    }
);

/* =========================================================
   START
========================================================= */

app.post(
    "/api/server/start",
    requireAuth,
    requireRole(
        "owner",
        "admin"
    ),
    async (req, res) => {

        try {

            await startServer();

            res.json({
                ok: true
            });

        } catch (error) {

            res
                .status(400)
                .json({
                    error:
                        error.message
                });
        }
    }
);

/* =========================================================
   STOP
========================================================= */

app.post(
    "/api/server/stop",
    requireAuth,
    requireRole(
        "owner",
        "admin"
    ),
    (req, res) => {

        stopServer();

        res.json({
            ok: true
        });
    }
);

/* =========================================================
   RESTART
========================================================= */

app.post(
    "/api/server/restart",
    requireAuth,
    requireRole(
        "owner",
        "admin"
    ),
    async (req, res) => {

        try {

            if (!minecraftProcess) {

                await startServer();

                return res.json({
                    ok: true
                });
            }

            stopServer();

            const startedAt =
                Date.now();

            const timer =
                setInterval(
                    async () => {

                        if (
                            !minecraftProcess &&
                            Date.now() -
                                startedAt >
                                2000
                        ) {

                            clearInterval(timer);

                            try {
                                await startServer();
                            } catch (error) {
                                log(
                                    error.message
                                );
                            }
                        }

                    },
                    500
                );

            res.json({
                ok: true
            });

        } catch (error) {

            res
                .status(400)
                .json({
                    error:
                        error.message
                });
        }
    }
);

/* =========================================================
   CONSOLE
========================================================= */

app.post(
    "/api/console",
    requireAuth,
    requireRole(
        "owner",
        "admin"
    ),
    (req, res) => {

        try {

            sendCommand(
                req.body.command
            );

            res.json({
                ok: true
            });

        } catch (error) {

            res
                .status(400)
                .json({
                    error:
                        error.message
                });
        }
    }
);

/* =========================================================
   SETTINGS
========================================================= */

app.post(
    "/api/settings",
    requireAuth,
    requireRole(
        "owner",
        "admin"
    ),
    (req, res) => {

        const body =
            req.body || {};

        db.settings = {

            maxPlayers:
                Math.max(
                    1,
                    Math.min(
                        Number(
                            body.maxPlayers || 20
                        ),
                        500
                    )
                ),

            difficulty:
                [
                    "peaceful",
                    "easy",
                    "normal",
                    "hard"
                ].includes(
                    body.difficulty
                )
                    ? body.difficulty
                    : "normal",

            gamemode:
                [
                    "survival",
                    "creative",
                    "adventure",
                    "spectator"
                ].includes(
                    body.gamemode
                )
                    ? body.gamemode
                    : "survival",

            pvp:
                !!body.pvp,

            whitelist:
                !!body.whitelist,

            onlineMode:
                !!body.onlineMode,

            viewDistance:
                Math.max(
                    2,
                    Math.min(
                        Number(
                            body.viewDistance || 10
                        ),
                        32
                    )
                ),

            simulationDistance:
                Math.max(
                    2,
                    Math.min(
                        Number(
                            body.simulationDistance ||
                            10
                        ),
                        32
                    )
                ),

            motd:
                String(
                    body.motd ||
                    "Minecraft Server"
                )
                    .replace(/\r?\n/g, " ")
                    .slice(0, 100)
        };

        /*
          Write immediately.
          If server is running, user must restart.
        */

        writeProperties();
        saveDB();

        res.json({
            ok: true,
            restartRequired:
                !!minecraftProcess
        });
    }
);

/* =========================================================
   PLAYER ACTIONS
========================================================= */

app.post(
    "/api/player/action",
    requireAuth,
    requireRole(
        "owner",
        "admin",
        "moderator"
    ),
    (req, res) => {

        try {

            const {
                player,
                action
            } = req.body;

            if (
                !player ||
                !/^[A-Za-z0-9_ .-]{1,32}$/
                    .test(player)
            ) {
                throw new Error(
                    "Invalid player name"
                );
            }

            const commands = {

                ban:
                    `ban ${player}`,

                pardon:
                    `pardon ${player}`,

                kick:
                    `kick ${player}`,

                op:
                    `op ${player}`,

                deop:
                    `deop ${player}`,

                whitelistAdd:
                    `whitelist add ${player}`,

                whitelistRemove:
                    `whitelist remove ${player}`
            };

            if (!commands[action]) {
                throw new Error(
                    "Invalid action"
                );
            }

            sendCommand(
                commands[action]
            );

            res.json({
                ok: true
            });

        } catch (error) {

            res
                .status(400)
                .json({
                    error:
                        error.message
                });
        }
    }
);

/* =========================================================
   USER MANAGEMENT
========================================================= */

app.get(
    "/api/users",
    requireAuth,
    requireRole("owner"),
    (req, res) => {

        res.json({
            users:
                db.users.map(
                    ({
                        password,
                        ...user
                    }) => user
                )
        });
    }
);

app.post(
    "/api/users",
    requireAuth,
    requireRole("owner"),
    (req, res) => {

        const {
            username,
            password,
            role
        } = req.body;

        if (
            !/^[A-Za-z0-9_.-]{3,32}$/
                .test(username || "")
        ) {
            return res
                .status(400)
                .json({
                    error:
                        "Invalid username"
                });
        }

        if (
            !password ||
            password.length < 6
        ) {
            return res
                .status(400)
                .json({
                    error:
                        "Password must be at least 6 characters"
                });
        }

        if (
            ![
                "admin",
                "moderator",
                "viewer"
            ].includes(role)
        ) {
            return res
                .status(400)
                .json({
                    error:
                        "Invalid role"
                });
        }

        if (
            db.users.some(
                u =>
                    u.username === username
            )
        ) {
            return res
                .status(400)
                .json({
                    error:
                        "User already exists"
                });
        }

        db.users.push({

            id:
                randomId(),

            username,

            password:
                hash(password),

            role,

            createdAt:
                Date.now()
        });

        saveDB();

        res.json({
            ok: true
        });
    }
);

app.delete(
    "/api/users/:id",
    requireAuth,
    requireRole("owner"),
    (req, res) => {

        if (
            req.params.id ===
            "owner"
        ) {
            return res
                .status(400)
                .json({
                    error:
                        "Owner cannot be deleted"
                });
        }

        db.users =
            db.users.filter(
                user =>
                    user.id !==
                    req.params.id
            );

        saveDB();

        res.json({
            ok: true
        });
    }
);

/* =========================================================
   BACKUP
========================================================= */

app.post(
    "/api/backup",
    requireAuth,
    requireRole(
        "owner",
        "admin"
    ),
    (req, res) => {

        const filename =
            `minecraft-${Date.now()}.tar.gz`;

        const destination =
            path.join(
                BACKUP_DIR,
                filename
            );

        execFile(
            "tar",
            [
                "-czf",
                destination,
                "-C",
                SERVER_DIR,
                "."
            ],
            error => {

                if (error) {

                    return res
                        .status(500)
                        .json({
                            error:
                                error.message
                        });
                }

                res.json({
                    ok: true,
                    filename
                });
            }
        );
    }
);

/* =========================================================
   FILE MANAGER
========================================================= */

function safePath(relative) {

    const root =
        path.resolve(
            SERVER_DIR
        );

    const target =
        path.resolve(
            SERVER_DIR,
            "." + (
                relative || ""
            )
        );

    if (
        target !== root &&
        !target.startsWith(
            root + path.sep
        )
    ) {
        throw new Error(
            "Invalid path"
        );
    }

    return target;
}

app.get(
    "/api/files",
    requireAuth,
    async (req, res) => {

        try {

            const relative =
                req.query.path || "";

            const directory =
                safePath(
                    relative
                );

            const items =
                fs.readdirSync(
                    directory,
                    {
                        withFileTypes: true
                    }
                )
                .map(
                    item => {

                        const full =
                            path.join(
                                directory,
                                item.name
                            );

                        return {

                            name:
                                item.name,

                            directory:
                                item.isDirectory(),

                            size:
                                item.isFile()
                                    ? fs.statSync(
                                        full
                                    ).size
                                    : 0
                        };
                    }
                );

            res.json({
                path:
                    relative,
                items
            });

        } catch (error) {

            res
                .status(400)
                .json({
                    error:
                        error.message
                });
        }
    }
);

app.get(
    "/api/file/download",
    requireAuth,
    (req, res) => {

        try {

            const file =
                safePath(
                    req.query.path
                );

            if (
                !fs.statSync(
                    file
                ).isFile()
            ) {
                throw new Error(
                    "Not a file"
                );
            }

            res.download(file);

        } catch (error) {

            res
                .status(400)
                .json({
                    error:
                        error.message
                });
        }
    }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
    "/health",
    (req, res) => {

        res.json({
            ok: true,
            minecraft:
                isRunning(),
            tcp:
                getMinecraftAddress()
        });
    }
);

/* =========================================================
   FRONTEND
========================================================= */

const HTML = `
<!DOCTYPE html>
<html lang="fa" dir="rtl">

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width,initial-scale=1"
>

<title>Minecraft Panel</title>

<style>

* {
    box-sizing:border-box;
}

body {
    margin:0;
    background:#070b16;
    color:#edf2ff;
    font-family:
        Tahoma,
        Arial,
        sans-serif;
}

button,
input,
select {
    font:inherit;
}

button {
    border:0;
    border-radius:10px;
    padding:11px 16px;
    cursor:pointer;
    background:#5865f2;
    color:white;
}

button:hover {
    filter:brightness(1.1);
}

button.red {
    background:#d9534f;
}

button.gray {
    background:#26334f;
}

input,
select {
    width:100%;
    background:#0c1426;
    color:white;
    border:1px solid #2c3b5b;
    border-radius:9px;
    padding:11px;
    margin-top:6px;
    margin-bottom:13px;
}

label {
    color:#aebbd5;
    font-size:13px;
}

.container {
    max-width:1250px;
    margin:auto;
    padding:24px;
}

.card {
    background:#10182b;
    border:1px solid #23314e;
    border-radius:17px;
    padding:20px;
    margin-bottom:17px;
}

.grid {
    display:grid;
    grid-template-columns:
        repeat(
            auto-fit,
            minmax(220px,1fr)
        );
    gap:15px;
}

.stat {
    font-size:27px;
    font-weight:bold;
    margin-top:7px;
}

.muted {
    color:#8fa0c0;
}

.green {
    color:#50df9a;
}

.redtext {
    color:#ff7777;
}

nav {
    display:flex;
    flex-wrap:wrap;
    gap:8px;
    margin:18px 0;
}

.tab {
    background:#17233d;
}

.tab.active {
    background:#5865f2;
}

.row {
    display:flex;
    gap:8px;
    align-items:center;
    flex-wrap:wrap;
}

.hidden {
    display:none!important;
}

pre {
    direction:ltr;
    text-align:left;
    background:#04070d;
    padding:15px;
    border-radius:12px;
    height:430px;
    overflow:auto;
    white-space:pre-wrap;
}

.login {
    max-width:430px;
    margin:10vh auto;
}

table {
    width:100%;
    border-collapse:collapse;
}

th,
td {
    text-align:right;
    padding:11px;
    border-bottom:
        1px solid #273654;
}

.address {
    font-size:20px;
    color:#5fe2a2;
    direction:ltr;
    text-align:left;
    background:#07140f;
    border-radius:10px;
    padding:13px;
}

.badge {
    display:inline-block;
    background:#20304e;
    border-radius:20px;
    padding:6px 10px;
    margin:3px;
}

</style>

</head>

<body>

<div id="login" class="container login">

<div class="card">

<h1>⛏️ Minecraft Panel</h1>

<p class="muted">
مدیریت Minecraft Server روی Railway
</p>

<label>
نام کاربری
</label>

<input
    id="username"
    value="admin"
>

<label>
رمز عبور
</label>

<input
    id="password"
    type="password"
>

<button
    onclick="login()"
    style="width:100%"
>
ورود
</button>

<p id="loginError" class="redtext"></p>

</div>

</div>

<div id="panel" class="container hidden">

<div
    class="row"
    style="justify-content:space-between"
>

<div>

<h1>
⛏️ Minecraft Server
</h1>

<span
    id="currentUser"
    class="badge"
></span>

</div>

<button
    class="gray"
    onclick="logout()"
>
خروج
</button>

</div>

<nav>

<button
    class="tab active"
    onclick="tab('dashboard',this)"
>
داشبورد
</button>

<button
    class="tab"
    onclick="tab('create',this)"
>
ساخت سرور
</button>

<button
    class="tab"
    onclick="tab('settings',this)"
>
تنظیمات
</button>

<button
    class="tab"
    onclick="tab('players',this)"
>
بازیکنان
</button>

<button
    class="tab"
    onclick="tab('console',this)"
>
Console
</button>

<button
    class="tab"
    onclick="tab('files',this)"
>
Files
</button>

<button
    id="usersButton"
    class="tab"
    onclick="tab('users',this)"
>
کاربران
</button>

</nav>

<!-- DASHBOARD -->

<section
    id="dashboard"
    class="section"
>

<div class="grid">

<div class="card">

<div class="muted">
وضعیت
</div>

<div
    id="status"
    class="stat"
>
-
</div>

</div>

<div class="card">

<div class="muted">
Minecraft
</div>

<div
    id="version"
    class="stat"
>
-
</div>

</div>

<div class="card">

<div class="muted">
نوع
</div>

<div
    id="type"
    class="stat"
>
-
</div>

</div>

<div class="card">

<div class="muted">
RAM
</div>

<div
    id="ram"
    class="stat"
>
-
</div>

</div>

</div>

<div class="card">

<h2>
🎮 آدرس Minecraft
</h2>

<div
    id="address"
    class="address"
>
در حال دریافت...
</div>

<p
    id="addressHelp"
    class="muted"
></p>

<div
    class="row"
    style="margin-top:15px"
>

<button
    onclick="serverAction('start')"
>
▶ Start
</button>

<button
    class="red"
    onclick="serverAction('stop')"
>
⏹ Stop
</button>

<button
    class="gray"
    onclick="serverAction('restart')"
>
🔄 Restart
</button>

<button
    class="gray"
    onclick="backup()"
>
💾 Backup
</button>

</div>

</div>

</section>

<!-- CREATE -->

<section
    id="create"
    class="section hidden"
>

<div class="card">

<h2>
🚀 ساخت Minecraft Server
</h2>

<div class="grid">

<div>

<label>
نسخه Minecraft
</label>

<select id="versionSelect">

<option>
1.21.11
</option>

<option>
1.21.10
</option>

<option>
1.21.9
</option>

<option>
1.21.8
</option>

<option>
1.21.7
</option>

<option>
1.21.6
</option>

<option>
1.21.5
</option>

<option>
1.21.4
</option>

<option>
1.21.3
</option>

<option>
1.21.2
</option>

<option>
1.21.1
</option>

<option>
1.21
</option>

</select>

</div>

<div>

<label>
نوع سرور
</label>

<select id="typeSelect">

<option value="vanilla">
Vanilla
</option>

<option value="fabric">
Fabric
</option>

<option value="paper">
Paper
</option>

<option value="purpur">
Purpur
</option>

<option value="forge">
Forge
</option>

<option value="neoforge">
NeoForge
</option>

</select>

</div>

<div>

<label>
RAM - MB
</label>

<input
    id="ramInput"
    type="number"
    value="2048"
    min="512"
>

</div>

<div>

<label>
Max Players
</label>

<input
    id="maxInput"
    type="number"
    value="20"
    min="1"
    max="500"
>

</div>

</div>

<button
    onclick="createServer()"
>
🚀 نصب سرور
</button>

<p id="createMessage"></p>

</div>

</section>

<!-- SETTINGS -->

<section
    id="settings"
    class="section hidden"
>

<div class="card">

<h2>
⚙️ تنظیمات
</h2>

<div class="grid">

<div>

<label>
Max Players
</label>

<input
    id="setMax"
    type="number"
>

</div>

<div>

<label>
Difficulty
</label>

<select id="setDifficulty">

<option>
peaceful
</option>

<option>
easy
</option>

<option>
normal
</option>

<option>
hard
</option>

</select>

</div>

<div>

<label>
Gamemode
</label>

<select id="setGamemode">

<option>
survival
</option>

<option>
creative
</option>

<option>
adventure
</option>

<option>
spectator
</option>

</select>

</div>

<div>

<label>
View Distance
</label>

<input
    id="setView"
    type="number"
>

</div>

<div>

<label>
Simulation Distance
</label>

<input
    id="setSimulation"
    type="number"
>

</div>

<div>

<label>
MOTD
</label>

<input
    id="setMotd"
>

</div>

</div>

<label>
<input
    id="setPvp"
    type="checkbox"
    style="width:auto"
>
PvP
</label>

<br>

<label>
<input
    id="setWhitelist"
    type="checkbox"
    style="width:auto"
>
Whitelist
</label>

<br>

<label>
<input
    id="setOnline"
    type="checkbox"
    style="width:auto"
>
Online Mode
</label>

<br><br>

<button
    onclick="saveSettings()"
>
ذخیره تنظیمات
</button>

<p
    id="settingsMessage"
></p>

</div>

</section>

<!-- PLAYERS -->

<section
    id="players"
    class="section hidden"
>

<div class="card">

<h2>
👥 مدیریت بازیکن
</h2>

<div class="row">

<input
    id="playerName"
    placeholder="PlayerName"
    style="max-width:300px"
>

<button
    onclick="playerAction('op')"
>
OP
</button>

<button
    onclick="playerAction('deop')"
>
De-OP
</button>

<button
    class="red"
    onclick="playerAction('ban')"
>
Ban
</button>

<button
    class="gray"
    onclick="playerAction('pardon')"
>
Unban
</button>

<button
    class="red"
    onclick="playerAction('kick')"
>
Kick
</button>

</div>

</div>

</section>

<!-- CONSOLE -->

<section
    id="console"
    class="section hidden"
>

<div class="card">

<h2>
🖥️ Console
</h2>

<pre id="logs"></pre>

<div class="row">

<input
    id="command"
    placeholder="مثلاً list"
    style="flex:1"
    onkeydown="
        if(event.key==='Enter')
        sendCommand()
    "
>

<button
    onclick="sendCommand()"
>
ارسال
</button>

</div>

</div>

</section>

<!-- FILES -->

<section
    id="files"
    class="section hidden"
>

<div class="card">

<h2>
📁 Server Files
</h2>

<div id="filesList"></div>

</div>

</section>

<!-- USERS -->

<section
    id="users"
    class="section hidden"
>

<div class="card">

<h2>
👑 کاربران پنل
</h2>

<div class="grid">

<input
    id="newUsername"
    placeholder="Username"
>

<input
    id="newPassword"
    type="password"
    placeholder="Password"
>

<select id="newRole">

<option value="admin">
Admin
</option>

<option value="moderator">
Moderator
</option>

<option value="viewer">
Viewer
</option>

</select>

</div>

<button
    onclick="addUser()"
>
افزودن کاربر
</button>

<div
    id="usersList"
    style="margin-top:20px"
></div>

</div>

</section>

</div>

<script>

let SESSION =
    localStorage.getItem(
        "minecraft_panel_session"
    );

const $ =
    id =>
        document.getElementById(id);

async function api(
    url,
    options = {}
) {

    options.headers = {
        ...(options.headers || {}),
        "Content-Type":
            "application/json",
        "X-Session":
            SESSION || ""
    };

    const response =
        await fetch(
            url,
            options
        );

    let data = {};

    try {
        data =
            await response.json();
    } catch {}

    if (
        response.status === 401
    ) {
        localStorage.removeItem(
            "minecraft_panel_session"
        );

        location.reload();
    }

    if (!response.ok) {
        throw new Error(
            data.error ||
            "Request failed"
        );
    }

    return data;
}

async function login() {

    try {

        const data =
            await api(
                "/api/login",
                {
                    method:"POST",
                    body:
                        JSON.stringify({
                            username:
                                $("username").value,
                            password:
                                $("password").value
                        })
                }
            );

        SESSION =
            data.session;

        localStorage.setItem(
            "minecraft_panel_session",
            SESSION
        );

        showPanel();

    } catch(error) {

        $("loginError")
            .textContent =
                error.message;
    }
}

async function logout() {

    try {

        await api(
            "/api/logout",
            {
                method:"POST"
            }
        );

    } catch {}

    localStorage.removeItem(
        "minecraft_panel_session"
    );

    location.reload();
}

async function showPanel() {

    try {

        const me =
            await api(
                "/api/me"
            ).catch(
                () => null
            );

        if (!me) {

            const state =
                await api(
                    "/api/state"
                );

            $("currentUser")
                .textContent =
                    state.user.username +
                    " · " +
                    state.user.role;

        } else {

            $("currentUser")
                .textContent =
                    me.username +
                    " · " +
                    me.role;

            if (
                me.role !== "owner"
            ) {
                $("usersButton")
                    .classList
                    .add("hidden");
            }
        }

        $("login")
            .classList
            .add("hidden");

        $("panel")
            .classList
            .remove("hidden");

        refresh();

    } catch {

        SESSION = null;

        localStorage.removeItem(
            "minecraft_panel_session"
        );
    }
}

async function refresh() {

    try {

        const data =
            await api(
                "/api/state"
            );

        $("status")
            .innerHTML =
                data.status.online
                    ? '<span class="green">🟢 Online</span>'
                    : '<span class="redtext">🔴 Offline</span>';

        $("version")
            .textContent =
                data.status.version ||
                "-";

        $("type")
            .textContent =
                data.status.type ||
                "-";

        $("ram")
            .textContent =
                data.status.ram
                    ? data.status.ram +
                      " MB"
                    : "-";

        if (
            data.status.address
        ) {

            $("address")
                .textContent =
                    data.status.address;

            $("addressHelp")
                .textContent =
                    "همین آدرس را در Multiplayer → Add Server وارد کنید.";

        } else {

            $("address")
                .textContent =
                    "TCP Proxy پیدا نشد";

            $("addressHelp")
                .textContent =
                    "Railway → Service → Settings → Networking → TCP Proxy → Internal Port: 25565";
        }

        $("logs")
            .textContent =
                data.logs
                    .map(
                        item =>
                            new Date(
                                item.time
                            ).toLocaleTimeString() +
                            " " +
                            item.text
                    )
                    .join("\\n");

        $("setMax")
            .value =
                data.settings.maxPlayers;

        $("setDifficulty")
            .value =
                data.settings.difficulty;

        $("setGamemode")
            .value =
                data.settings.gamemode;

        $("setView")
            .value =
                data.settings.viewDistance;

        $("setSimulation")
            .value =
                data.settings.simulationDistance;

        $("setMotd")
            .value =
                data.settings.motd;

        $("setPvp")
            .checked =
                data.settings.pvp;

        $("setWhitelist")
            .checked =
                data.settings.whitelist;

        $("setOnline")
            .checked =
                data.settings.onlineMode;

    } catch {}
}

function tab(
    id,
    button
) {

    document
        .querySelectorAll(
            ".section"
        )
        .forEach(
            element =>
                element.classList
                    .add("hidden")
        );

    $(id)
        .classList
        .remove("hidden");

    document
        .querySelectorAll(
            ".tab"
        )
        .forEach(
            element =>
                element.classList
                    .remove("active")
        );

    button
        .classList
        .add("active");

    if (
        id === "files"
    ) {
        loadFiles();
    }

    if (
        id === "users"
    ) {
        loadUsers();
    }
}

async function serverAction(
    action
) {

    try {

        await api(
            "/api/server/" +
            action,
            {
                method:"POST"
            }
        );

        setTimeout(
            refresh,
            1000
        );

    } catch(error) {

        alert(
            error.message
        );
    }
}

async function createServer() {

    if (
        !confirm(
            "سرور جدید نصب شود؟"
        )
    ) {
        return;
    }

    $("createMessage")
        .textContent =
            "⏳ در حال دانلود و نصب...";

    try {

        await api(
            "/api/server/create",
            {
                method:"POST",

                body:
                    JSON.stringify({
                        version:
                            $("versionSelect")
                                .value,

                        type:
                            $("typeSelect")
                                .value,

                        ram:
                            Number(
                                $("ramInput")
                                    .value
                            ),

                        maxPlayers:
                            Number(
                                $("maxInput")
                                    .value
                            )
                    })
            }
        );

        $("createMessage")
            .innerHTML =
                '<span class="green">✅ نصب با موفقیت انجام شد. حالا Start را بزن.</span>';

        refresh();

    } catch(error) {

        $("createMessage")
            .innerHTML =
                '<span class="redtext">❌ ' +
                error.message +
                '</span>';
    }
}

async function saveSettings() {

    try {

        const data =
            await api(
                "/api/settings",
                {
                    method:"POST",

                    body:
                        JSON.stringify({

                            maxPlayers:
                                Number(
                                    $("setMax")
                                        .value
                                ),

                            difficulty:
                                $("setDifficulty")
                                    .value,

                            gamemode:
                                $("setGamemode")
                                    .value,

                            viewDistance:
                                Number(
                                    $("setView")
                                        .value
                                ),

                            simulationDistance:
                                Number(
                                    $("setSimulation")
                                        .value
                                ),

                            motd:
                                $("setMotd")
                                    .value,

                            pvp:
                                $("setPvp")
                                    .checked,

                            whitelist:
                                $("setWhitelist")
                                    .checked,

                            onlineMode:
                                $("setOnline")
                                    .checked
                        })
                }
            );

        $("settingsMessage")
            .innerHTML =
                data.restartRequired
                    ? '<span class="green">ذخیره شد. برای اعمال تنظیمات Restart کنید.</span>'
                    : '<span class="green">ذخیره شد.</span>';

    } catch(error) {

        $("settingsMessage")
            .textContent =
                error.message;
    }
}

async function sendCommand() {

    const command =
        $("command")
            .value
            .trim();

    if (!command) {
        return;
    }

    try {

        await api(
            "/api/console",
            {
                method:"POST",
                body:
                    JSON.stringify({
                        command
                    })
            }
        );

        $("command")
            .value = "";

        refresh();

    } catch(error) {

        alert(
            error.message
        );
    }
}

async function playerAction(
    action
) {

    const player =
        $("playerName")
            .value
            .trim();

    if (!player) {
        return;
    }

    try {

        await api(
            "/api/player/action",
            {
                method:"POST",

                body:
                    JSON.stringify({
                        player,
                        action
                    })
            }
        );

        alert(
            "Command sent"
        );

    } catch(error) {

        alert(
            error.message
        );
    }
}

async function backup() {

    try {

        const data =
            await api(
                "/api/backup",
                {
                    method:"POST"
                }
            );

        alert(
            "Backup created: " +
            data.filename
        );

    } catch(error) {

        alert(
            error.message
        );
    }
}

async function loadFiles(
    directory = ""
) {

    try {

        const data =
            await api(
                "/api/files?path=" +
                encodeURIComponent(
                    directory
                )
            );

        let html =
            "<p class='muted'>/" +
            data.path +
            "</p>";

        html +=
            "<table>" +
            "<tr>" +
            "<th>نام</th>" +
            "<th>نوع</th>" +
            "<th>اندازه</th>" +
            "<th>عملیات</th>" +
            "</tr>";

        for (
            const item
            of data.items
        ) {

            const currentPath =
                (
                    data.path
                        ? data.path + "/"
                        : ""
                ) +
                item.name;

            html +=
                "<tr>";

            html +=
                "<td>" +
                item.name +
                "</td>";

            html +=
                "<td>" +
                (
                    item.directory
                        ? "📁"
                        : "📄"
                ) +
                "</td>";

            html +=
                "<td>" +
                item.size +
                "</td>";

            if (
                item.directory
            ) {

                html +=
                    "<td>" +
                    "<button onclick=\"loadFiles('" +
                    currentPath +
                    "')\">" +
                    "باز کردن" +
                    "</button>" +
                    "</td>";

            } else {

                html +=
                    "<td>" +
                    "<a target='_blank' href='/api/file/download?path=" +
                    encodeURIComponent(
                        currentPath
                    ) +
                    "'>" +
                    "دانلود" +
                    "</a>" +
                    "</td>";
            }

            html +=
                "</tr>";
        }

        html +=
            "</table>";

        $("filesList")
            .innerHTML =
                html;

    } catch(error) {

        $("filesList")
            .textContent =
                error.message;
    }
}

async function loadUsers() {

    try {

        const data =
            await api(
                "/api/users"
            );

        let html =
            "<table>" +
            "<tr>" +
            "<th>Username</th>" +
            "<th>Role</th>" +
            "<th></th>" +
            "</tr>";

        for (
            const user
            of data.users
        ) {

            html +=
                "<tr>";

            html +=
                "<td>" +
                user.username +
                "</td>";

            html +=
                "<td>" +
                user.role +
                "</td>";

            html +=
                "<td>" +
                (
                    user.id === "owner"
                        ? "👑 Owner"
                        :
                        "<button class='red' onclick=\"deleteUser('" +
                        user.id +
                        "')\">" +
                        "حذف" +
                        "</button>"
                ) +
                "</td>";

            html +=
                "</tr>";
        }

        html +=
            "</table>";

        $("usersList")
            .innerHTML =
                html;

    } catch(error) {

        $("usersList")
            .textContent =
                error.message;
    }
}

async function addUser() {

    try {

        await api(
            "/api/users",
            {
                method:"POST",

                body:
                    JSON.stringify({

                        username:
                            $("newUsername")
                                .value,

                        password:
                            $("newPassword")
                                .value,

                        role:
                            $("newRole")
                                .value
                    })
            }
        );

        $("newUsername")
            .value = "";

        $("newPassword")
            .value = "";

        loadUsers();

    } catch(error) {

        alert(
            error.message
        );
    }
}

async function deleteUser(
    id
) {

    if (
        !confirm(
            "این کاربر حذف شود؟"
        )
    ) {
        return;
    }

    try {

        await api(
            "/api/users/" +
            id,
            {
                method:"DELETE"
            }
        );

        loadUsers();

    } catch(error) {

        alert(
            error.message
        );
    }
}

/*
  Auto refresh.
*/

setInterval(
    () => {

        if (SESSION) {
            refresh();
        }

    },
    3000
);

/*
  Login automatically if a session exists.
*/

if (SESSION) {
    showPanel();
}

</script>

</body>

</html>
`;

app.get(
    "/",
    (req, res) => {
        res
            .type("html")
            .send(HTML);
    }
);

/* =========================================================
   START HTTP
========================================================= */

app.listen(
    PORT,
    () => {

        console.log(
            "================================"
        );

        console.log(
            `Panel listening on ${PORT}`
        );

        console.log(
            `Minecraft internal port: ${MC_PORT}`
        );

        console.log(
            `TCP Proxy: ${
                getMinecraftAddress() ||
                "NOT AVAILABLE"
            }`
        );

        console.log(
            "================================"
        );
    }
);

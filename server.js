const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const readline = require("readline");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 3000);
const MC_PORT = Number(process.env.MC_PORT || 25565);
const DATA_DIR = process.env.DATA_DIR || "/data";
const SERVER_DIR = path.join(DATA_DIR, "server");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const DB_FILE = path.join(DATA_DIR, "panel.json");

fs.mkdirSync(SERVER_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const state = {
  child: null,
  logs: [],
  created: false,
  config: null
};

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}
function token() {
  return crypto.randomBytes(32).toString("hex");
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function writeJSON(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

let db = readJSON(DB_FILE, {
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
    motd: "Railway Minecraft Server"
  }
});

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me-now";

if (!db.users.length) {
  db.users.push({
    id: "owner",
    username: ADMIN_USER,
    password: sha256(ADMIN_PASSWORD),
    role: "owner",
    createdAt: Date.now()
  });
  writeJSON(DB_FILE, db);
}

function addLog(line) {
  const text = String(line).replace(/\r/g, "");
  if (!text.trim()) return;
  state.logs.push({ time: Date.now(), text });
  if (state.logs.length > 500) state.logs.splice(0, state.logs.length - 500);
  console.log(text);
}

function safeJoin(base, userPath) {
  const target = path.resolve(base, "." + (userPath || ""));
  if (!target.startsWith(path.resolve(base) + path.sep) && target !== path.resolve(base)) {
    throw new Error("Invalid path");
  }
  return target;
}

function currentUser(req) {
  const sid = req.headers["x-session"] || req.cookies?.session;
  if (!sid) return null;
  return sessions.get(sid) || null;
}
const sessions = new Map();

function auth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "ورود لازم است" });
  req.user = u;
  next();
}
function role(...allowed) {
  return (req, res, next) => {
    if (!allowed.includes(req.user.role)) return res.status(403).json({ error: "دسترسی ندارید" });
    next();
  };
}

function serverStatus() {
  return {
    online: !!state.child,
    pid: state.child?.pid || null,
    version: db.server?.version || null,
    type: db.server?.type || null,
    ram: db.server?.ram || null,
    address: process.env.RAILWAY_TCP_PROXY_DOMAIN
      ? `${process.env.RAILWAY_TCP_PROXY_DOMAIN}:${process.env.RAILWAY_TCP_PROXY_PORT || ""}`
      : null
  };
}

function writeServerProperties() {
  const p = path.join(SERVER_DIR, "server.properties");
  const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const map = {};
  for (const line of existing.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    map[line.slice(0, i)] = line.slice(i + 1);
  }
  const s = db.settings;
  map["server-port"] = String(MC_PORT);
  map["max-players"] = String(s.maxPlayers);
  map["difficulty"] = s.difficulty;
  map["gamemode"] = s.gamemode;
  map["pvp"] = String(s.pvp);
  map["white-list"] = String(s.whitelist);
  map["online-mode"] = String(s.onlineMode);
  map["view-distance"] = String(s.viewDistance);
  map["simulation-distance"] = String(s.simulationDistance);
  map["motd"] = s.motd;
  fs.writeFileSync(p, Object.entries(map).map(([k,v]) => `${k}=${String(v).replace(/\n/g, " ")}`).join("\n") + "\n");
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    const c = require("https");
    const http = require("http");
    const go = (u, redirects=0) => {
      const mod = u.startsWith("https:") ? c : http;
      const req = mod.get(u, { headers: { "User-Agent": "Railway-Minecraft-Panel/1.0" } }, res => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && redirects < 5) {
          res.resume(); return go(new URL(res.headers.location, u).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume(); return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        res.pipe(out);
        out.on("finish", () => out.close(resolve));
      });
      req.on("error", reject);
    };
    go(url);
  });
}

async function installServer(version, type) {
  const v = String(version);
  const t = String(type).toLowerCase();
  fs.mkdirSync(SERVER_DIR, { recursive: true });

  // Keep old server files if reinstalling, but remove old launcher jars.
  for (const f of fs.readdirSync(SERVER_DIR)) {
    if (/^(server|fabric-server|paper|purpur|forge|neoforge).*\.jar$/i.test(f)) {
      try { fs.unlinkSync(path.join(SERVER_DIR, f)); } catch {}
    }
  }

  if (t === "vanilla") {
    const manifest = await fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json").then(r => r.json());
    const item = manifest.versions.find(x => x.id === v);
    if (!item) throw new Error("نسخه Vanilla پیدا نشد");
    const meta = await fetch(item.url).then(r => r.json());
    const url = meta.downloads?.server?.url;
    if (!url) throw new Error("Server Jar برای این نسخه موجود نیست");
    await download(url, path.join(SERVER_DIR, "server.jar"));
    return { launch: ["-jar", "server.jar", "nogui"] };
  }

  if (t === "fabric") {
    const loaders = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(v)}`).then(r => r.json());
    if (!loaders?.length) throw new Error("Fabric برای این نسخه موجود نیست");
    const loader = loaders[0].version;
    const installers = await fetch("https://meta.fabricmc.net/v2/versions/installer").then(r => r.json());
    const installer = installers[0]?.version;
    if (!installer) throw new Error("Fabric Installer پیدا نشد");
    const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(v)}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`;
    await download(url, path.join(SERVER_DIR, "fabric-server-launch.jar"));
    return { launch: ["-jar", "fabric-server-launch.jar", "nogui"] };
  }

  if (t === "paper") {
    const meta = await fetch(`https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(v)}`).then(r => r.json());
    if (!meta.builds?.length) throw new Error("Paper برای این نسخه موجود نیست");
    const build = meta.builds[meta.builds.length - 1];
    const jarName = meta.builds ? (await fetch(`https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(v)}/builds/${build}`).then(r=>r.json())).downloads?.application?.name : null;
    const name = jarName || `paper-${v}-${build}.jar`;
    const url = `https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(v)}/builds/${build}/downloads/${encodeURIComponent(name)}`;
    await download(url, path.join(SERVER_DIR, "server.jar"));
    return { launch: ["-jar", "server.jar", "nogui"] };
  }

  if (t === "purpur") {
    const meta = await fetch(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(v)}`).then(r => r.json());
    const build = meta.builds?.latest;
    if (!build) throw new Error("Purpur برای این نسخه موجود نیست");
    const url = `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(v)}/${build}/download`;
    await download(url, path.join(SERVER_DIR, "server.jar"));
    return { launch: ["-jar", "server.jar", "nogui"] };
  }

  if (t === "forge") {
    const promo = await fetch(`https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json`).then(r => r.json());
    const key = `${v}-recommended`;
    const loader = promo.promos?.[key] || promo.promos?.[`${v}-latest`];
    if (!loader) throw new Error("Forge برای این نسخه Loader پیدا نشد");
    const installerName = `forge-${v}-${loader}-installer.jar`;
    const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${v}-${loader}/${installerName}`;
    const installer = path.join(SERVER_DIR, "forge-installer.jar");
    await download(url, installer);
    await new Promise((resolve, reject) => {
      const p = spawn("java", ["-jar", "forge-installer.jar", "--installServer"], { cwd: SERVER_DIR });
      p.stdout.on("data", d => addLog("[Forge] " + d));
      p.stderr.on("data", d => addLog("[Forge] " + d));
      p.on("close", code => code === 0 ? resolve() : reject(new Error("Forge installer failed: " + code)));
    });
    const run = path.join(SERVER_DIR, "run.sh");
    if (!fs.existsSync(run)) throw new Error("Forge run.sh ساخته نشد");
    fs.chmodSync(run, 0o755);
    return { shell: "./run.sh nogui" };
  }

  if (t === "neoforge") {
    const html = await fetch("https://projects.neoforged.net/neoforged/neoforge").then(r=>r.text());
    const match = html.match(/(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)/g)?.find(x => x.startsWith(v + "."));
    if (!match) throw new Error("برای NeoForge باید نسخه دقیق Loader مشخص شود؛ این نسخه خودکار پیدا نشد.");
    const installerName = `neoforge-${match}-installer.jar`;
    const installer = path.join(SERVER_DIR, "neoforge-installer.jar");
    await download(`https://maven.neoforged.net/releases/net/neoforged/neoforge/${match}/${installerName}`, installer);
    await new Promise((resolve, reject) => {
      const p = spawn("java", ["-jar", "neoforge-installer.jar", "--installServer"], { cwd: SERVER_DIR });
      p.stdout.on("data", d => addLog("[NeoForge] " + d));
      p.stderr.on("data", d => addLog("[NeoForge] " + d));
      p.on("close", code => code === 0 ? resolve() : reject(new Error("NeoForge installer failed: " + code)));
    });
    const run = path.join(SERVER_DIR, "run.sh");
    if (!fs.existsSync(run)) throw new Error("NeoForge run.sh ساخته نشد");
    fs.chmodSync(run, 0o755);
    return { shell: "./run.sh nogui" };
  }

  throw new Error("نوع سرور پشتیبانی نمی‌شود");
}

async function startServer() {
  if (state.child) return;
  if (!db.server) throw new Error("اول سرور را بسازید");
  if (!fs.existsSync(path.join(SERVER_DIR, "eula.txt"))) {
    fs.writeFileSync(path.join(SERVER_DIR, "eula.txt"), "eula=true\n");
  }
  writeServerProperties();

  const ram = Math.max(512, Math.min(Number(db.server.ram || 2048), 16384));
  const javaArgs = [`-Xms${Math.min(1024, ram)}M`, `-Xmx${ram}M`, "-XX:+UseG1GC"];
  let child;

  if (db.server.shell) {
    child = spawn("sh", ["-lc", `exec ${db.server.shell}`], { cwd: SERVER_DIR, env: { ...process.env, JAVA_OPTS: javaArgs.join(" ") } });
  } else {
    child = spawn("java", [...javaArgs, ...(db.server.launch || ["-jar","server.jar","nogui"])], { cwd: SERVER_DIR, env: process.env });
  }

  state.child = child;
  addLog("=== SERVER STARTING ===");
  child.stdout.on("data", d => d.toString().split(/\r?\n/).forEach(addLog));
  child.stderr.on("data", d => d.toString().split(/\r?\n/).forEach(x => addLog("[stderr] " + x)));
  child.on("close", code => {
    addLog(`=== SERVER STOPPED (${code}) ===`);
    state.child = null;
  });
}

function stopServer() {
  if (!state.child) return;
  state.child.stdin.write("stop\n");
  setTimeout(() => {
    if (state.child) {
      try { state.child.kill("SIGTERM"); } catch {}
    }
  }, 15000);
}

function command(cmd) {
  if (!state.child) throw new Error("سرور خاموش است");
  state.child.stdin.write(String(cmd).trim() + "\n");
}

async function listPlayers() {
  if (!state.child) return [];
  command("list");
  await new Promise(r => setTimeout(r, 400));
  const recent = state.logs.slice(-10).map(x => x.text).join("\n");
  const m = recent.match(/There are \d+ of a max of \d+ players online: ?(.*)/);
  if (!m || !m[1]) return [];
  return m[1].split(",").map(x => x.trim()).filter(Boolean);
}

app.get("/", (req,res)=>res.type("html").send(HTML));

app.post("/api/login", (req,res)=>{
  const { username, password } = req.body || {};
  const u = db.users.find(x => x.username === username && x.password === sha256(password || ""));
  if (!u) return res.status(401).json({ error: "نام کاربری یا رمز عبور اشتباه است" });
  const sid = token();
  sessions.set(sid, { id:u.id, username:u.username, role:u.role });
  res.json({ session:sid, user:{username:u.username, role:u.role} });
});
app.post("/api/logout", auth, (req,res)=>{
  const sid = req.headers["x-session"];
  sessions.delete(sid);
  res.json({ok:true});
});
app.get("/api/me", auth, (req,res)=>res.json(req.user));

app.get("/api/state", auth, (req,res)=>res.json({
  user:req.user,
  status:serverStatus(),
  settings:db.settings,
  server:db.server,
  logs:state.logs.slice(-100)
}));

app.post("/api/server/create", auth, role("owner","admin"), async (req,res)=>{
  try {
    const {version,type,ram,maxPlayers} = req.body;
    if (!version || !type) throw new Error("نسخه و نوع سرور را انتخاب کنید");
    if (state.child) throw new Error("ابتدا سرور را خاموش کنید");
    const ramNum = Math.max(512, Math.min(Number(ram || 2048), 16384));
    const result = await installServer(version,type);
    db.server = { version, type, ram:ramNum, ...result, createdAt:Date.now() };
    if (maxPlayers) db.settings.maxPlayers = Math.max(1, Math.min(Number(maxPlayers), 500));
    writeJSON(DB_FILE, db);
    writeServerProperties();
    res.json({ok:true, server:db.server});
  } catch(e) { res.status(400).json({error:e.message}); }
});

app.post("/api/server/start", auth, role("owner","admin"), async (req,res)=>{
  try { await startServer(); res.json({ok:true}); } catch(e){res.status(400).json({error:e.message});}
});
app.post("/api/server/stop", auth, role("owner","admin"), (req,res)=>{
  try { stopServer(); res.json({ok:true}); } catch(e){res.status(400).json({error:e.message});}
});
app.post("/api/server/restart", auth, role("owner","admin"), async (req,res)=>{
  try { stopServer(); setTimeout(startServer, 3000); res.json({ok:true}); } catch(e){res.status(400).json({error:e.message});}
});
app.post("/api/console", auth, role("owner","admin"), (req,res)=>{
  try { command(req.body.command); res.json({ok:true}); } catch(e){res.status(400).json({error:e.message});}
});

app.get("/api/players", auth, async (req,res)=>{
  try { res.json({players:await listPlayers()}); } catch(e){res.status(400).json({error:e.message});}
});
app.post("/api/players/action", auth, role("owner","admin","moderator"), (req,res)=>{
  try {
    const {player,action} = req.body;
    if (!player || !/^[\w .-]{1,32}$/u.test(player)) throw new Error("نام بازیکن نامعتبر است");
    const allowed = {ban:`ban ${player}`,unban:`pardon ${player}`,kick:`kick ${player}`,op:`op ${player}`,deop:`deop ${player}`,whitelist:`whitelist add ${player}`,unwhitelist:`whitelist remove ${player}`};
    if (!allowed[action]) throw new Error("عملیات نامعتبر");
    command(allowed[action]);
    res.json({ok:true});
  } catch(e){res.status(400).json({error:e.message});}
});

app.post("/api/settings", auth, role("owner","admin"), (req,res)=>{
  const s = req.body || {};
  db.settings = {
    ...db.settings,
    maxPlayers: Math.max(1, Math.min(Number(s.maxPlayers || 20), 500)),
    difficulty: ["peaceful","easy","normal","hard"].includes(s.difficulty) ? s.difficulty : "normal",
    gamemode: ["survival","creative","adventure","spectator"].includes(s.gamemode) ? s.gamemode : "survival",
    pvp: !!s.pvp, whitelist:!!s.whitelist, onlineMode:!!s.onlineMode,
    viewDistance:Math.max(2,Math.min(Number(s.viewDistance||10),32)),
    simulationDistance:Math.max(2,Math.min(Number(s.simulationDistance||10),32)),
    motd:String(s.motd||"Minecraft Server").slice(0,100)
  };
  writeJSON(DB_FILE,db);
  writeServerProperties();
  if (state.child) addLog("Settings changed; restart the server to apply all properties.");
  res.json({ok:true,settings:db.settings});
});

app.get("/api/users", auth, role("owner"), (req,res)=>{
  res.json({users:db.users.map(({password,...u})=>u)});
});
app.post("/api/users", auth, role("owner"), (req,res)=>{
  const {username,password,role:rr} = req.body;
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username||"")) return res.status(400).json({error:"نام کاربری نامعتبر"});
  if (!password || password.length < 6) return res.status(400).json({error:"رمز حداقل ۶ کاراکتر"});
  if (!["admin","moderator","viewer"].includes(rr)) return res.status(400).json({error:"نقش نامعتبر"});
  if (db.users.some(x=>x.username===username)) return res.status(400).json({error:"کاربر موجود است"});
  db.users.push({id:token().slice(0,12),username,password:sha256(password),role:rr,createdAt:Date.now()});
  writeJSON(DB_FILE,db);
  res.json({ok:true});
});
app.delete("/api/users/:id", auth, role("owner"), (req,res)=>{
  if (req.params.id === "owner") return res.status(400).json({error:"مالک قابل حذف نیست"});
  db.users = db.users.filter(x=>x.id !== req.params.id);
  writeJSON(DB_FILE,db);
  res.json({ok:true});
});

app.get("/api/files", auth, (req,res)=>{
  try {
    const dir = safeJoin(SERVER_DIR, req.query.path || "");
    const items = fs.readdirSync(dir,{withFileTypes:true}).map(x=>({
      name:x.name, dir:x.isDirectory(), size:x.isFile()?fs.statSync(path.join(dir,x.name)).size:0
    }));
    res.json({path:req.query.path||"",items});
  } catch(e){res.status(400).json({error:e.message});}
});

app.get("/api/download", auth, (req,res)=>{
  try {
    const f=safeJoin(SERVER_DIR,req.query.path||"");
    if(!fs.statSync(f).isFile()) throw new Error("فایل نیست");
    res.download(f);
  } catch(e){res.status(400).json({error:e.message});}
});

app.post("/api/backup", auth, role("owner","admin"), (req,res)=>{
  const name=`backup-${new Date().toISOString().replace(/[:.]/g,"-")}.tar.gz`;
  execFile("tar",["-czf",path.join(BACKUP_DIR,name),"-C",SERVER_DIR,"."],err=>{
    if(err) return res.status(500).json({error:err.message});
    res.json({ok:true,name});
  });
});

app.get("/api/health",(req,res)=>res.json({ok:true,online:!!state.child}));

app.listen(PORT,()=>console.log(`Panel HTTP listening on ${PORT}`));

const HTML = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Minecraft Railway Panel</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:Tahoma,Arial,sans-serif;background:#0b1020;color:#eef2ff}
button,input,select{font:inherit}button{cursor:pointer;border:0;border-radius:10px;padding:11px 15px;background:#5865f2;color:white}
button.danger{background:#e05252}button.secondary{background:#202a44}.hidden{display:none!important}
.wrap{max-width:1250px;margin:auto;padding:24px}.login{max-width:430px;margin:8vh auto;background:#111a30;padding:28px;border-radius:20px;box-shadow:0 20px 60px #0005}
h1{margin-top:0}.muted{color:#93a4c7}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.card{background:#111a30;border:1px solid #22304e;border-radius:16px;padding:18px}.stat{font-size:28px;font-weight:bold}
input,select{width:100%;padding:11px;border-radius:9px;border:1px solid #30405f;background:#0c1427;color:#fff;margin:6px 0 12px}
label{display:block;font-size:13px;color:#aebbd5}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
nav{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.tab{background:#16223b}.tab.active{background:#5865f2}
pre{background:#050914;border-radius:12px;padding:14px;height:390px;overflow:auto;direction:ltr;text-align:left;white-space:pre-wrap}
table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #263653;text-align:right}
.badge{padding:5px 9px;border-radius:999px;background:#203052;font-size:12px}.online{background:#1e6b4d}.offline{background:#553044}
.small{font-size:12px}.dangerText{color:#ff7c7c}.ok{color:#5fe0a2}
</style>
</head>
<body>
<div id="login" class="login">
<h1>🎮 Minecraft Panel</h1><p class="muted">مدیریت سرور Minecraft روی Railway</p>
<label>نام کاربری</label><input id="lu" value="admin">
<label>رمز عبور</label><input id="lp" type="password">
<button onclick="login()" style="width:100%">ورود</button>
<p id="le" class="dangerText"></p>
</div>

<div id="app" class="wrap hidden">
<header class="row" style="justify-content:space-between">
<div><h1>⛏️ Minecraft Server</h1><div class="muted">پنل مدیریت</div></div>
<div class="row"><span id="who" class="badge"></span><button class="secondary" onclick="logout()">خروج</button></div>
</header>

<nav>
<button class="tab active" onclick="showTab('dashboard',this)">داشبورد</button>
<button class="tab" onclick="showTab('server',this)">ساخت سرور</button>
<button class="tab" onclick="showTab('settings',this)">تنظیمات</button>
<button class="tab" onclick="showTab('players',this)">بازیکنان</button>
<button class="tab" onclick="showTab('console',this)">Console</button>
<button class="tab" onclick="showTab('files',this)">Files</button>
<button id="usersTab" class="tab" onclick="showTab('users',this)">کاربران</button>
</nav>

<section id="dashboard" class="tabsec">
<div class="grid">
<div class="card"><div class="muted">وضعیت</div><div id="status" class="stat">—</div></div>
<div class="card"><div class="muted">نسخه</div><div id="version" class="stat">—</div></div>
<div class="card"><div class="muted">نوع</div><div id="type" class="stat">—</div></div>
<div class="card"><div class="muted">RAM</div><div id="ram" class="stat">—</div></div>
</div>
<div class="card" style="margin-top:16px">
<h2>اتصال</h2><p id="address" class="ok">TCP Proxy را در Railway فعال کنید تا آدرس اتصال نمایش داده شود.</p>
<div class="row"><button onclick="act('start')">▶ Start</button><button class="danger" onclick="act('stop')">⏹ Stop</button><button class="secondary" onclick="act('restart')">🔄 Restart</button><button class="secondary" onclick="backup()">💾 Backup</button></div>
</div>
</section>

<section id="server" class="tabsec hidden">
<div class="card">
<h2>ساخت / نصب سرور</h2>
<p class="muted">برای شروع نسخه و Loader را انتخاب کنید. نصب ممکن است چند دقیقه طول بکشد.</p>
<div class="grid">
<div><label>نسخه Minecraft</label><select id="sv"><option>1.21</option><option>1.21.1</option><option>1.21.2</option><option>1.21.3</option><option>1.21.4</option><option>1.21.5</option><option>1.21.6</option><option>1.21.7</option><option>1.21.8</option><option>1.21.9</option><option>1.21.10</option><option>1.21.11</option></select></div>
<div><label>نوع سرور</label><select id="st"><option value="vanilla">Vanilla</option><option value="fabric">Fabric</option><option value="forge">Forge</option><option value="neoforge">NeoForge</option><option value="paper">Paper</option><option value="purpur">Purpur</option></select></div>
<div><label>RAM (MB)</label><input id="sram" type="number" min="512" max="16384" value="2048"></div>
<div><label>Max Players</label><input id="smax" type="number" min="1" max="500" value="20"></div>
</div>
<button onclick="createServer()">🚀 ساخت / نصب</button>
<p id="createMsg"></p>
</div>
</section>

<section id="settings" class="tabsec hidden"><div class="card">
<h2>⚙️ تنظیمات Minecraft</h2>
<div class="grid">
<div><label>Max Players</label><input id="maxPlayers" type="number"></div>
<div><label>Difficulty</label><select id="difficulty"><option>peaceful</option><option>easy</option><option>normal</option><option>hard</option></select></div>
<div><label>Gamemode</label><select id="gamemode"><option>survival</option><option>creative</option><option>adventure</option><option>spectator</option></select></div>
<div><label>View Distance</label><input id="viewDistance" type="number"></div>
<div><label>Simulation Distance</label><input id="simulationDistance" type="number"></div>
<div><label>MOTD</label><input id="motd"></div>
</div>
<label><input id="pvp" type="checkbox" style="width:auto"> PvP</label>
<label><input id="whitelist" type="checkbox" style="width:auto"> Whitelist</label>
<label><input id="onlineMode" type="checkbox" style="width:auto"> Online Mode</label>
<br><button onclick="saveSettings()">ذخیره</button>
</div></section>

<section id="players" class="tabsec hidden"><div class="card">
<h2>👥 بازیکنان</h2><button onclick="loadPlayers()">به‌روزرسانی</button><div id="plist" style="margin-top:15px"></div>
<p class="muted">برای Ban/Kick/OP نام بازیکن را وارد کنید.</p>
<div class="row"><input id="playerName" placeholder="PlayerName" style="max-width:260px"><button onclick="playerAction('ban')">Ban</button><button onclick="playerAction('kick')">Kick</button><button onclick="playerAction('op')">OP</button><button class="secondary" onclick="playerAction('unban')">Unban</button></div>
</div></section>

<section id="console" class="tabsec hidden"><div class="card">
<h2>🖥️ Console</h2><pre id="logs"></pre>
<div class="row"><input id="cmd" placeholder="مثلاً list یا say Hello" onkeydown="if(event.key==='Enter')sendCmd()" style="flex:1"><button onclick="sendCmd()">ارسال</button></div>
</div></section>

<section id="files" class="tabsec hidden"><div class="card"><h2>📁 Server Files</h2><div id="filesList"></div></div></section>

<section id="users" class="tabsec hidden"><div class="card">
<h2>👑 مدیریت کاربران پنل</h2>
<div class="grid"><input id="newUser" placeholder="username"><input id="newPass" type="password" placeholder="password"><select id="newRole"><option value="admin">Admin</option><option value="moderator">Moderator</option><option value="viewer">Viewer</option></select></div>
<button onclick="addUser()">افزودن کاربر</button><div id="usersList" style="margin-top:15px"></div>
</div></section>
</div>

<script>
let S=localStorage.getItem('mc_session');
const $=id=>document.getElementById(id);
async function api(url,opt={}){opt.headers={...(opt.headers||{}), 'Content-Type':'application/json','X-Session':S||''};const r=await fetch(url,opt);let d={};try{d=await r.json()}catch{}if(r.status===401){localStorage.removeItem('mc_session');location.reload()}if(!r.ok)throw new Error(d.error||'خطا');return d}
async function login(){try{const d=await api('/api/login',{method:'POST',body:JSON.stringify({username:$('lu').value,password:$('lp').value})});S=d.session;localStorage.setItem('mc_session',S);boot()}catch(e){$('le').textContent=e.message}}
async function boot(){if(!S)return;try{const me=await api('/api/me');$('login').classList.add('hidden');$('app').classList.remove('hidden');$('who').textContent=me.username+' · '+me.role;if(me.role!=='owner')$('usersTab').classList.add('hidden');refresh()}catch{}}
async function logout(){try{await api('/api/logout',{method:'POST'})}catch{}localStorage.removeItem('mc_session');location.reload()}
function showTab(id,b){document.querySelectorAll('.tabsec').forEach(x=>x.classList.add('hidden'));$(id).classList.remove('hidden');document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');if(id==='files')loadFiles();if(id==='users')loadUsers();if(id==='players')loadPlayers()}
async function refresh(){const d=await api('/api/state');$('status').innerHTML=d.status.online?'<span class="ok">🟢 Online</span>':'<span class="dangerText">🔴 Offline</span>';$('version').textContent=d.status.version||'—';$('type').textContent=d.status.type||'—';$('ram').textContent=d.status.ram?d.status.ram+' MB':'—';$('address').textContent=d.status.address||'Railway → Settings → Networking → TCP Proxy → Internal Port: 25565';$('logs').textContent=d.logs.map(x=>new Date(x.time).toLocaleTimeString()+' '+x.text).join('\\n');const s=d.settings;$('maxPlayers').value=s.maxPlayers;$('difficulty').value=s.difficulty;$('gamemode').value=s.gamemode;$('viewDistance').value=s.viewDistance;$('simulationDistance').value=s.simulationDistance;$('motd').value=s.motd;$('pvp').checked=s.pvp;$('whitelist').checked=s.whitelist;$('onlineMode').checked=s.onlineMode}
async function act(x){try{await api('/api/server/'+x,{method:'POST'});setTimeout(refresh,700)}catch(e){alert(e.message)}}
async function createServer(){if(!confirm('نصب سرور انتخابی انجام شود؟'))return;$('createMsg').textContent='در حال دانلود و نصب...';try{await api('/api/server/create',{method:'POST',body:JSON.stringify({version:$('sv').value,type:$('st').value,ram:$('sram').value,maxPlayers:$('smax').value})});$('createMsg').textContent='✅ نصب شد؛ اکنون Start را بزنید.';refresh()}catch(e){$('createMsg').textContent='❌ '+e.message}}
async function saveSettings(){try{await api('/api/settings',{method:'POST',body:JSON.stringify({maxPlayers:$('maxPlayers').value,difficulty:$('difficulty').value,gamemode:$('gamemode').value,viewDistance:$('viewDistance').value,simulationDistance:$('simulationDistance').value,motd:$('motd').value,pvp:$('pvp').checked,whitelist:$('whitelist').checked,onlineMode:$('onlineMode').checked})});alert('ذخیره شد')}catch(e){alert(e.message)}}
async function sendCmd(){const c=$('cmd').value;if(!c)return;try{await api('/api/console',{method:'POST',body:JSON.stringify({command:c})});$('cmd').value='';refresh()}catch(e){alert(e.message)}}
async function loadPlayers(){try{const d=await api('/api/players');$('plist').innerHTML=d.players.length?d.players.map(x=>'<span class="badge">'+x+'</span> ').join(''):'بازیکن آنلاینی نیست'}catch(e){$('plist').textContent=e.message}}
async function playerAction(a){const p=$('playerName').value.trim();if(!p)return;try{await api('/api/players/action',{method:'POST',body:JSON.stringify({player:p,action:a})});loadPlayers()}catch(e){alert(e.message)}}
async function loadFiles(p=''){try{const d=await api('/api/files?path='+encodeURIComponent(p));$('filesList').innerHTML='<div class="muted">/'+d.path+'</div><table><tr><th>نام</th><th>نوع</th><th>اندازه</th><th></th></tr>'+d.items.map(x=>'<tr><td>'+x.name+'</td><td>'+ (x.dir?'📁':'📄')+'</td><td>'+x.size+'</td><td>'+(!x.dir?'<a target="_blank" href="/api/download?path='+encodeURIComponent((d.path?d.path+'/':'')+x.name)+'">دانلود</a>':'')+'</td></tr>').join('')+'</table>'}catch(e){$('filesList').textContent=e.message}}
async function backup(){try{const d=await api('/api/backup',{method:'POST'});alert('Backup ساخته شد: '+d.name)}catch(e){alert(e.message)}}
async function loadUsers(){try{const d=await api('/api/users');$('usersList').innerHTML='<table><tr><th>کاربر</th><th>نقش</th><th></th></tr>'+d.users.map(u=>'<tr><td>'+u.username+'</td><td>'+u.role+'</td><td>'+(u.id!=='owner'?'<button class="danger" onclick="delUser(\\''+u.id+'\\')">حذف</button>':'مالک')+'</td></tr>').join('')+'</table>'}catch(e){$('usersList').textContent=e.message}}
async function addUser(){try{await api('/api/users',{method:'POST',body:JSON.stringify({username:$('newUser').value,password:$('newPass').value,role:$('newRole').value})});$('newUser').value='';$('newPass').value='';loadUsers()}catch(e){alert(e.message)}}
async function delUser(id){if(!confirm('حذف شود؟'))return;try{await api('/api/users/'+id,{method:'DELETE'});loadUsers()}catch(e){alert(e.message)}}
setInterval(()=>{if(S)refresh()},3000);boot();
</script>
</body></html>`;

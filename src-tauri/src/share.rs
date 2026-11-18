//! Share over Wi-Fi, like Calibre's content server: while switched on, a
//! small web page on this device lists the library, and another device on
//! the same network can open it in a browser and download books.
//!
//! - Off unless she switches it on, and off again when the app closes.
//! - A new six-digit PIN each time; ten wrong PINs and it stops answering
//!   until it is switched off and on again.
//! - Reads only: nothing can be changed or uploaded through it.
//! - Plain std networking, one short-lived thread per request.

use anyhow::{anyhow, Result};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// One book as the page lists it.
#[derive(Clone)]
pub struct Item {
    pub id: i64,
    pub title: String,
    pub author: String,
    pub series: String,
    pub format: String,
    pub path: String,
    pub has_cover: bool,
}

/// What the server asks the app for.
pub trait Library: Send + Sync + 'static {
    fn items(&self) -> Vec<Item>;
    fn cover(&self, id: i64) -> Option<(Vec<u8>, String)>;
}

#[derive(Default)]
pub struct Share {
    running: Mutex<Option<Running>>,
}

struct Running {
    url: String,
    pin: String,
    stop: Arc<AtomicBool>,
}

#[derive(serde::Serialize, Clone)]
pub struct Status {
    pub url: String,
    pub pin: String,
}

/// This device's address on the local network. Connecting a UDP socket
/// sends nothing; it only makes the system choose the outgoing address.
fn local_ip() -> Option<std::net::IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.168.0.1:9").or_else(|_| s.connect("10.0.0.1:9")).ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

fn random_digits(n: usize) -> String {
    // Not for cryptography; enough for a short-lived PIN and session.
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(7)
        ^ (std::process::id() as u64).rotate_left(32);
    let mut out = String::new();
    for _ in 0..n {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        out.push(char::from(b'0' + (seed % 10) as u8));
    }
    out
}

impl Share {
    pub fn status(&self) -> Option<Status> {
        let r = self.running.lock().ok()?;
        r.as_ref().map(|r| Status { url: r.url.clone(), pin: r.pin.clone() })
    }

    pub fn stop(&self) {
        if let Ok(mut r) = self.running.lock() {
            if let Some(run) = r.take() {
                run.stop.store(true, Ordering::SeqCst);
            }
        }
    }

    pub fn start(&self, lib: Arc<dyn Library>) -> Result<Status> {
        if let Some(s) = self.status() {
            return Ok(s);
        }
        let ip = local_ip().ok_or_else(|| anyhow!("connect to a Wi-Fi network first"))?;
        let listener = [8080u16, 8081, 8082, 8090, 0]
            .iter()
            .find_map(|p| TcpListener::bind(("0.0.0.0", *p)).ok())
            .ok_or_else(|| anyhow!("no network port was free"))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let pin = random_digits(6);
        let session = random_digits(24);
        let stop = Arc::new(AtomicBool::new(false));
        let url = format!("http://{ip}:{port}/");

        let ctx = Arc::new(Ctx { lib, pin: pin.clone(), session, wrong: AtomicU32::new(0) });
        let stop_flag = stop.clone();
        std::thread::spawn(move || {
            while !stop_flag.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let ctx = ctx.clone();
                        std::thread::spawn(move || {
                            let _ = serve(stream, &ctx);
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(150));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(300)),
                }
            }
        });

        let status = Status { url: url.clone(), pin: pin.clone() };
        *self.running.lock().map_err(|_| anyhow!("busy"))? = Some(Running { url, pin, stop });
        Ok(status)
    }
}

struct Ctx {
    lib: Arc<dyn Library>,
    pin: String,
    session: String,
    wrong: AtomicU32,
}

const MAX_WRONG: u32 = 10;

struct Request {
    method: String,
    path: String,
    query: String,
    cookie: String,
    body: String,
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    let head_end;
    loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            head_end = i + 4;
            break;
        }
        if buf.len() > 16 * 1024 {
            return None;
        }
    }
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let target = first.next()?.to_string();
    let (path, query) = target.split_once('?').map(|(p, q)| (p.to_string(), q.to_string())).unwrap_or((target, String::new()));
    let mut cookie = String::new();
    let mut length = 0usize;
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "cookie" => cookie = v.trim().to_string(),
                "content-length" => length = v.trim().parse().unwrap_or(0).min(4096),
                _ => {}
            }
        }
    }
    let mut body = buf[head_end..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(length);
    Some(Request { method, path, query, cookie, body: String::from_utf8_lossy(&body).into_owned() })
}

fn respond(stream: &mut TcpStream, status: &str, kind: &str, extra: &str, body: &[u8]) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n\
         X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n{extra}\r\n",
        body.len()
    )?;
    stream.write_all(body)
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn form_value(body: &str, key: &str) -> Option<String> {
    body.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| v.replace('+', " "))
    })
}

const STYLE: &str = "body{font-family:system-ui,sans-serif;margin:0;background:#1d1b19;color:#eee}\
header{padding:14px 16px;background:#262320;position:sticky;top:0;display:flex;gap:10px;align-items:center;flex-wrap:wrap}\
h1{font-size:18px;margin:0;flex:1}input{font-size:16px;padding:8px 10px;border-radius:8px;border:1px solid #444;background:#111;color:#eee}\
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:14px;padding:16px}\
.b{background:#262320;border-radius:10px;overflow:hidden;display:flex;flex-direction:column}\
.c{aspect-ratio:2/3;background:#333;display:grid;place-items:center;text-align:center;padding:6px;font-size:13px;color:#aaa}\
.c img{width:100%;height:100%;object-fit:cover}.m{padding:8px;font-size:13px;flex:1}.m b{display:block}\
.m span{color:#aaa}a.d{display:block;text-align:center;padding:8px;background:#c98a5c;color:#111;text-decoration:none;font-weight:600}\
form{max-width:320px;margin:20vh auto;text-align:center}button{font-size:16px;padding:8px 16px;border-radius:8px;border:0;background:#c98a5c}";

fn pin_page(note: &str) -> Vec<u8> {
    format!(
        "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>FicShelf</title>\
         <style>{STYLE}</style><form method=post action=/login><h1>FicShelf</h1><p>Enter the PIN shown on the device \
         sharing its library.</p><p><input name=pin inputmode=numeric autocomplete=off autofocus></p><p>{}</p>\
         <button>Open the library</button></form>",
        esc(note)
    )
    .into_bytes()
}

fn library_page(items: &[Item]) -> Vec<u8> {
    let mut cards = String::new();
    for it in items {
        let cover = if it.has_cover {
            format!("<img loading=lazy src='/cover/{}' alt=''>", it.id)
        } else {
            esc(&it.title)
        };
        let search = esc(&format!("{} {} {}", it.title, it.author, it.series).to_lowercase());
        let label = if std::path::Path::new(&it.path).is_dir() { "".to_string() } else {
            format!("<a class=d href='/book/{}'>Download {}</a>", it.id, esc(&it.format.to_uppercase()))
        };
        cards.push_str(&format!(
            "<div class=b data-s=\"{search}\"><div class=c>{cover}</div><div class=m><b>{}</b><span>{}</span></div>{label}</div>",
            esc(&it.title),
            esc(&it.author)
        ));
    }
    format!(
        "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>FicShelf library</title>\
         <style>{STYLE}</style><header><h1>FicShelf · {} books</h1><input id=q type=search placeholder='Search…'></header>\
         <div class=grid id=g>{cards}</div><script>q.oninput=()=>{{const v=q.value.toLowerCase();\
         for(const e of g.children)e.style.display=e.dataset.s.includes(v)?'':'none'}}</script>",
        items.len()
    )
    .into_bytes()
}

fn serve(mut stream: TcpStream, ctx: &Ctx) -> std::io::Result<()> {
    let Some(req) = read_request(&mut stream) else { return Ok(()) };
    if ctx.wrong.load(Ordering::SeqCst) >= MAX_WRONG {
        return respond(&mut stream, "403 Forbidden", "text/plain", "", b"Too many wrong PINs. Switch sharing off and on again on the device.");
    }
    let cookie_ok = req.cookie.split(';').any(|c| c.trim() == format!("fs={}", ctx.session));

    if req.method == "POST" && req.path == "/login" {
        let given = form_value(&req.body, "pin").unwrap_or_default();
        if given.trim() == ctx.pin {
            ctx.wrong.store(0, Ordering::SeqCst);
            let set = format!("Set-Cookie: fs={}; HttpOnly; SameSite=Strict; Path=/\r\nLocation: /\r\n", ctx.session);
            return respond(&mut stream, "303 See Other", "text/plain", &set, b"");
        }
        let n = ctx.wrong.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::sleep(Duration::from_millis(800)); // slow down guessing
        let note = format!("That PIN is not right ({} tries left).", MAX_WRONG.saturating_sub(n));
        return respond(&mut stream, "200 OK", "text/html; charset=utf-8", "", &pin_page(&note));
    }
    if !cookie_ok {
        let _ = &req.query;
        return respond(&mut stream, "200 OK", "text/html; charset=utf-8", "", &pin_page(""));
    }

    let id_of = |prefix: &str| req.path.strip_prefix(prefix).and_then(|s| s.parse::<i64>().ok());
    if req.path == "/" {
        let mut items = ctx.lib.items();
        items.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        return respond(&mut stream, "200 OK", "text/html; charset=utf-8", "", &library_page(&items));
    }
    if let Some(id) = id_of("/cover/") {
        return match ctx.lib.cover(id) {
            Some((bytes, mime)) => respond(&mut stream, "200 OK", &mime, "", &bytes),
            None => respond(&mut stream, "404 Not Found", "text/plain", "", b"No cover"),
        };
    }
    if let Some(id) = id_of("/book/") {
        let Some(item) = ctx.lib.items().into_iter().find(|i| i.id == id) else {
            return respond(&mut stream, "404 Not Found", "text/plain", "", b"Not in the library");
        };
        let path = std::path::PathBuf::from(&item.path);
        let Ok(mut f) = std::fs::File::open(&path) else {
            return respond(&mut stream, "404 Not Found", "text/plain", "", b"That file is not on this device any more");
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        let name: String = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "book".into())
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || " ._-()[]".contains(c) { c } else { '_' })
            .collect();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {len}\r\n\
             Content-Disposition: attachment; filename=\"{name}\"\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        )?;
        std::io::copy(&mut f, &mut stream)?;
        return Ok(());
    }
    respond(&mut stream, "404 Not Found", "text/plain", "", b"Not found")
}

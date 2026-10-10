use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, bail, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::Mutex;

const RELEASES: &str = include_str!("../../../tools/agent-browser/releases.json");
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_COMMAND_OUTPUT: u64 = 64 * 1024;
const LINUX_ARM64_REMEDY: &str = "This agent-browser release cannot download Chrome for Linux ARM64. Install Chromium with your system package manager, then set AGENT_BROWSER_EXECUTABLE_PATH to its absolute path (for example /usr/bin/chromium). Sprocket never installs system packages or runs sudo.";

struct BrowserInstallation {
    cli: PathBuf,
    chromium: PathBuf,
}

pub(crate) struct BrowserInstaller {
    tools_dir: PathBuf,
    configured_chromium: Option<PathBuf>,
    releases: Releases,
    client: reqwest::Client,
    browser: Mutex<Option<BrowserInstallation>>,
    lightpanda: Mutex<Option<PathBuf>>,
}

impl BrowserInstaller {
    pub fn new(data_dir: PathBuf, configured_chromium: Option<PathBuf>) -> anyhow::Result<Self> {
        let releases: Releases = serde_json::from_str(RELEASES)?;
        Ok(Self {
            tools_dir: data_dir.join("tools"),
            configured_chromium,
            browser: Mutex::new(None),
            lightpanda: Mutex::new(None),
            releases,
            client: reqwest::Client::builder()
                .user_agent(concat!("sprocket/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(30))
                .timeout(DOWNLOAD_TIMEOUT)
                .build()?,
        })
    }

    pub async fn ensure_ready(&self) -> anyhow::Result<PathBuf> {
        let mut browser = self.browser.lock().await;
        if let Some(installed) = browser.as_ref() {
            if executable_file(&installed.cli).await && executable_file(&installed.chromium).await {
                return Ok(installed.cli.clone());
            }
        }
        let cli = self.install_tool(Tool::AgentBrowser).await?;
        self.ensure_skills().await?;
        let chromium = self.ensure_chromium(&cli).await?;
        *browser = Some(BrowserInstallation {
            cli: cli.clone(),
            chromium,
        });
        Ok(cli)
    }

    pub fn cli_directory(&self) -> anyhow::Result<PathBuf> {
        Ok(self
            .tools_dir
            .join("agent-browser")
            .join(&self.releases.agent_browser.version)
            .join(platform_key(
                Tool::AgentBrowser,
                std::env::consts::OS,
                std::env::consts::ARCH,
            )?))
    }

    pub fn skills_directory(&self) -> PathBuf {
        self.tools_dir
            .join("agent-browser")
            .join(&self.releases.agent_browser.version)
            .join("skill-data")
    }

    async fn ensure_skills(&self) -> anyhow::Result<()> {
        let destination = self.skills_directory();
        let parent = destination.parent().context("skills directory")?;
        let _lock = acquire_lock(parent.join("skills-install.lock")).await?;
        if destination.join("core/SKILL.md").is_file() {
            return Ok(());
        }
        let archive = parent.join("source.tar.gz");
        let release = &self.releases.skill_data;
        download_atomic(&self.client, &release.url, &release.asset, &archive).await?;
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let temporary =
                tempfile::tempdir_in(destination.parent().context("skills directory")?)?;
            let reader = flate2::read::GzDecoder::new(File::open(archive)?);
            let mut archive = tar::Archive::new(std::io::Read::take(reader, 64 * 1024 * 1024));
            for entry in archive.entries()? {
                let mut entry = entry?;
                if !entry.header().entry_type().is_file() {
                    continue;
                }
                let path = entry.path()?.into_owned();
                let components: Vec<_> = path.components().collect();
                if components
                    .get(1)
                    .is_none_or(|component| component.as_os_str() != "skill-data")
                {
                    continue;
                }
                ensure!(
                    components
                        .iter()
                        .all(|component| matches!(component, std::path::Component::Normal(_))),
                    "Invalid upstream skill path"
                );
                let relative: PathBuf = components[2..].iter().collect();
                let target = temporary.path().join(relative);
                std::fs::create_dir_all(target.parent().context("skill file directory")?)?;
                std::io::copy(&mut entry, &mut File::create(target)?)?;
            }
            ensure!(
                temporary.path().join("core/SKILL.md").is_file(),
                "Upstream core browser skill is missing"
            );
            std::fs::rename(temporary.path(), destination)?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn existing_chromium(&self) -> Option<PathBuf> {
        if let Ok(browser) = self.browser.try_lock()
            && let Some(installed) = browser.as_ref()
            && executable_file(&installed.chromium).await
        {
            return Some(installed.chromium.clone());
        }
        if let Some(path) = &self.configured_chromium {
            return (path.is_absolute() && executable_file(path).await).then(|| path.clone());
        }
        find_chromium().await
    }

    pub async fn ensure_lightpanda(&self) -> anyhow::Result<PathBuf> {
        let mut lightpanda = self.lightpanda.lock().await;
        if let Some(path) = lightpanda.as_ref() {
            return Ok(path.clone());
        }
        let executable = self.install_tool(Tool::Lightpanda).await?;
        run_command(
            Command::new(&executable).arg("version"),
            Duration::from_secs(30),
        )
        .await
        .context("Lightpanda cannot run on this host; official Linux binaries require glibc")?;
        *lightpanda = Some(executable.clone());
        Ok(executable)
    }

    pub async fn installed_lightpanda(&self) -> Option<PathBuf> {
        let mut installed = self.lightpanda.try_lock().ok()?;
        if let Some(path) = installed.as_ref() {
            return Some(path.clone());
        }
        let release = &self.releases.lightpanda;
        let platform = platform_key(
            Tool::Lightpanda,
            std::env::consts::OS,
            std::env::consts::ARCH,
        )
        .ok()?;
        let path = self
            .tools_dir
            .join("lightpanda")
            .join(&release.version)
            .join(platform)
            .join("lightpanda");
        let asset = release.platforms.get(platform)?;
        if verified_file(&path, asset).await.ok()? {
            *installed = Some(path.clone());
            return Some(path);
        }
        None
    }

    async fn install_tool(&self, tool: Tool) -> anyhow::Result<PathBuf> {
        let release = match tool {
            Tool::AgentBrowser => &self.releases.agent_browser,
            Tool::Lightpanda => &self.releases.lightpanda,
        };
        let platform = platform_key(tool, std::env::consts::OS, std::env::consts::ARCH)?;
        let asset = release
            .platforms
            .get(platform)
            .context("missing pinned release")?;
        let directory = self
            .tools_dir
            .join(tool.name())
            .join(&release.version)
            .join(platform);
        tokio::fs::create_dir_all(&directory).await?;
        let _lock = acquire_lock(directory.join("install.lock")).await?;
        let path = directory.join(if cfg!(windows) {
            format!("{}.exe", tool.name())
        } else {
            tool.name().to_owned()
        });
        if verified_file(&path, asset).await? {
            return Ok(path);
        }
        let url = format!(
            "https://github.com/{}/releases/download/{}/{}",
            release.repository, release.tag, asset.asset
        );
        download_atomic(&self.client, &url, asset, &path).await?;
        Ok(path)
    }

    async fn ensure_chromium(&self, cli: &Path) -> anyhow::Result<PathBuf> {
        if let Some(configured) = &self.configured_chromium {
            ensure!(
                configured.is_absolute(),
                "Configured Chromium path must be absolute"
            );
            ensure!(
                executable_file(configured).await,
                "Configured Chromium executable {} is missing or not executable; fix the configured path",
                configured.display()
            );
            return Ok(configured.clone());
        }
        if let Some(path) = find_chromium().await {
            return Ok(path);
        }
        ensure!(
            !(cfg!(target_os = "linux") && cfg!(target_arch = "aarch64")),
            "{LINUX_ARM64_REMEDY}"
        );
        let home = home_dir().context("Cannot install Chromium without a home directory; configure an existing browser executable")?;
        let browsers = home.join(".agent-browser/browsers");
        tokio::fs::create_dir_all(&browsers).await?;
        let _lock = acquire_lock(browsers.join("sprocket-install.lock")).await?;
        if let Some(path) = find_chromium().await {
            return Ok(path);
        }
        run_command(Command::new(cli).arg("install"), COMMAND_TIMEOUT)
            .await
            .context("Unprivileged Chromium installation failed. Configure an existing Chromium executable; install any missing system libraries yourself. Sprocket never runs sudo")?;
        find_chromium().await.context("agent-browser install finished but no Chromium executable was found; configure its absolute executable path")
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tool {
    AgentBrowser,
    Lightpanda,
}

impl Tool {
    fn name(self) -> &'static str {
        match self {
            Self::AgentBrowser => "agent-browser",
            Self::Lightpanda => "lightpanda",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Releases {
    agent_browser: Release,
    lightpanda: Release,
    skill_data: SkillRelease,
}

#[derive(Deserialize)]
struct SkillRelease {
    url: String,
    #[serde(flatten)]
    asset: ReleaseAsset,
}

#[derive(Deserialize)]
struct Release {
    version: String,
    repository: String,
    tag: String,
    platforms: BTreeMap<String, ReleaseAsset>,
}

#[derive(Deserialize)]
struct ReleaseAsset {
    asset: String,
    bytes: u64,
    sha256: String,
}

fn platform_key(tool: Tool, os: &str, arch: &str) -> anyhow::Result<&'static str> {
    match (tool, os, arch) {
        (_, "macos", "aarch64") => Ok("darwin-arm64"),
        (_, "macos", "x86_64") => Ok("darwin-x64"),
        (Tool::AgentBrowser, "linux", "aarch64") => Ok("linux-musl-arm64"),
        (Tool::AgentBrowser, "linux", "x86_64") => Ok("linux-musl-x64"),
        (Tool::AgentBrowser, "windows", "x86_64" | "aarch64") => Ok("win32-x64"),
        (Tool::Lightpanda, "linux", "aarch64") => Ok("linux-arm64"),
        (Tool::Lightpanda, "linux", "x86_64") => Ok("linux-x64"),
        _ => bail!("No pinned native {} release for {os}/{arch}", tool.name()),
    }
}

async fn acquire_lock(path: PathBuf) -> anyhow::Result<File> {
    let file = tokio::task::spawn_blocking(move || {
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)
    })
    .await??;
    let deadline = tokio::time::Instant::now() + COMMAND_TIMEOUT + DOWNLOAD_TIMEOUT;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) => {
                ensure!(
                    tokio::time::Instant::now() < deadline,
                    "Browser installation lock timed out; retry setup"
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(std::fs::TryLockError::Error(error)) => return Err(error.into()),
        }
    }
}

fn hash_hex(hash: impl AsRef<[u8]>) -> String {
    hash.as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

async fn verified_file(path: &Path, asset: &ReleaseAsset) -> anyhow::Result<bool> {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if file.metadata().await?.len() != asset.bytes || !executable_file(path).await {
        return Ok(false);
    }
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hash_hex(hash.finalize()) == asset.sha256)
}

async fn download_atomic(
    client: &reqwest::Client,
    url: &str,
    asset: &ReleaseAsset,
    destination: &Path,
) -> anyhow::Result<()> {
    let parent = destination.parent().context("install path has no parent")?;
    let temporary = tempfile::NamedTempFile::new_in(parent)?;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(temporary.path())
        .await?;
    let mut response = client.get(url).send().await?.error_for_status()?;
    if let Some(length) = response.content_length() {
        ensure!(
            length == asset.bytes,
            "Pinned release size mismatch for {url}"
        );
    }
    let mut hash = Sha256::new();
    let mut downloaded = 0u64;
    while let Some(chunk) = response.chunk().await? {
        downloaded += chunk.len() as u64;
        ensure!(
            downloaded <= asset.bytes,
            "Pinned release exceeds expected size for {url}"
        );
        hash.update(&chunk);
        file.write_all(&chunk).await?;
    }
    ensure!(
        downloaded == asset.bytes,
        "Incomplete pinned release download for {url}"
    );
    ensure!(
        hash_hex(hash.finalize()) == asset.sha256,
        "Pinned release SHA256 mismatch for {url}"
    );
    file.flush().await?;
    drop(file);
    let destination = destination.to_owned();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temporary
                .as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o755))?;
        }
        temporary.as_file().sync_all()?;
        temporary
            .persist(&destination)
            .context("publish verified executable")?;
        #[cfg(unix)]
        File::open(destination.parent().context("install path has no parent")?)?.sync_all()?;
        Ok(())
    })
    .await??;
    Ok(())
}

async fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = tokio::fs::metadata(path).await else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    true
}

async fn run_command(command: &mut Command, limit: Duration) -> anyhow::Result<()> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = child.stdout.take().context("missing command stdout")?;
    let stderr = child.stderr.take().context("missing command stderr")?;
    let output = tokio::time::timeout(limit, async {
        let (status, stdout_bytes, stderr_bytes) =
            tokio::try_join!(child.wait(), command_output(stdout), command_output(stderr))?;
        ensure!(
            status.success(),
            "Browser helper exited with {status}: {} {}",
            String::from_utf8_lossy(&stdout_bytes).trim(),
            String::from_utf8_lossy(&stderr_bytes).trim()
        );
        Ok::<_, anyhow::Error>(())
    })
    .await;
    if !matches!(output, Ok(Ok(()))) {
        let _ = child.kill().await;
    }
    output.context("Browser helper timed out")?
}

async fn command_output(reader: impl tokio::io::AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_COMMAND_OUTPUT + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() as u64 > MAX_COMMAND_OUTPUT {
        return Err(std::io::Error::other(
            "Browser installer produced excessive output",
        ));
    }
    Ok(bytes)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

async fn find_chromium() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            for name in [
                "google-chrome",
                "google-chrome-stable",
                "chromium",
                "chromium-browser",
                "brave-browser",
                "brave-browser-stable",
                "microsoft-edge",
                "microsoft-edge-stable",
            ] {
                candidates.push(directory.join(if cfg!(windows) {
                    format!("{name}.exe")
                } else {
                    name.to_owned()
                }));
            }
        }
    }
    #[cfg(target_os = "macos")]
    for base in [
        Some(PathBuf::from("/Applications")),
        home_dir().map(|home| home.join("Applications")),
    ]
    .into_iter()
    .flatten()
    {
        for (app, binary) in [
            ("Google Chrome", "Google Chrome"),
            ("Google Chrome Canary", "Google Chrome Canary"),
            ("Chromium", "Chromium"),
            ("Brave Browser", "Brave Browser"),
            ("Microsoft Edge", "Microsoft Edge"),
        ] {
            candidates.push(base.join(format!("{app}.app/Contents/MacOS/{binary}")));
        }
    }
    #[cfg(windows)]
    for base in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"]
        .into_iter()
        .filter_map(std::env::var_os)
    {
        for browser in [
            "Google/Chrome/Application/chrome.exe",
            "Chromium/Application/chrome.exe",
            "BraveSoftware/Brave-Browser/Application/brave.exe",
            "Microsoft/Edge/Application/msedge.exe",
        ] {
            candidates.push(PathBuf::from(&base).join(browser));
        }
    }
    for candidate in candidates {
        if candidate.is_absolute() && executable_file(&candidate).await {
            return Some(candidate);
        }
    }
    let home = home_dir()?;
    let mut caches = vec![
        home.join(".agent-browser/browsers"),
        std::env::var_os("PUPPETEER_CACHE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".cache/puppeteer"))
            .join("chrome"),
    ];
    if let Some(path) = std::env::var_os("PLAYWRIGHT_BROWSERS_PATH").filter(|path| path != "0") {
        caches.push(PathBuf::from(path));
    } else if cfg!(target_os = "macos") {
        caches.push(home.join("Library/Caches/ms-playwright"));
    } else if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            caches.push(PathBuf::from(local).join("ms-playwright"));
        }
    } else {
        caches.push(
            std::env::var_os("XDG_CACHE_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".cache"))
                .join("ms-playwright"),
        );
    }
    for cache in caches {
        if let Some(path) = find_cached_chromium(&cache).await {
            return Some(path);
        }
    }
    None
}

async fn find_cached_chromium(cache: &Path) -> Option<PathBuf> {
    let mut entries = tokio::fs::read_dir(cache).await.ok()?;
    let mut directories = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.file_type().await.ok()?.is_dir() {
            directories.push(entry.path());
        }
    }
    directories.sort_by(|a, b| b.cmp(a));
    for directory in directories {
        for relative in [
            "chrome",
            "chrome.exe",
            "chrome-linux64/chrome",
            "chrome-linux/chrome",
            "chrome-win64/chrome.exe",
            "chrome-win/chrome.exe",
            "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        ] {
            let candidate = directory.join(relative);
            if candidate.is_absolute() && executable_file(&candidate).await {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture_server(payload: &'static [u8]) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = axum::Router::new().route(
            "/binary",
            axum::routing::get(move || async move { payload }),
        );
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (format!("http://{address}/binary"), task)
    }

    #[tokio::test]
    async fn publishes_verified_download_and_preserves_it_on_failed_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent-browser");
        let payload = b"verified browser executable";
        let asset = ReleaseAsset {
            asset: "fixture".into(),
            bytes: payload.len() as u64,
            sha256: hash_hex(Sha256::digest(payload)),
        };
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let (url, server) = fixture_server(payload).await;
        download_atomic(&client, &url, &asset, &path).await.unwrap();
        assert!(verified_file(&path, &asset).await.unwrap());
        assert_eq!(tokio::fs::read(&path).await.unwrap(), payload);
        server.abort();
        let (url, server) = fixture_server(b"corrupt browser executable!").await;
        assert!(download_atomic(&client, &url, &asset, &path).await.is_err());
        assert!(verified_file(&path, &asset).await.unwrap());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        server.abort();
    }

    #[tokio::test]
    async fn rejects_partial_download_before_publication() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent-browser");
        let asset = ReleaseAsset {
            asset: "fixture".into(),
            bytes: 100,
            sha256: "unused".into(),
        };
        let (url, server) = fixture_server(b"partial").await;
        assert!(
            download_atomic(
                &reqwest::Client::builder().no_proxy().build().unwrap(),
                &url,
                &asset,
                &path
            )
            .await
            .is_err()
        );
        assert!(!path.exists());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        server.abort();
    }

    #[tokio::test]
    async fn cached_browser_and_explicit_executable_do_not_run_installer() {
        let directory = tempfile::tempdir().unwrap();
        let cache = directory.path().join("chrome-123");
        tokio::fs::create_dir(&cache).await.unwrap();
        let executable = cache.join(if cfg!(windows) {
            "chrome.exe"
        } else {
            "chrome"
        });
        tokio::fs::write(&executable, b"existing browser")
            .await
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(
            find_cached_chromium(directory.path()).await,
            Some(executable.clone())
        );
        let installer =
            BrowserInstaller::new(directory.path().to_owned(), Some(executable.clone())).unwrap();
        assert_eq!(
            installer
                .ensure_chromium(&directory.path().join("missing-cli"))
                .await
                .unwrap(),
            executable
        );
    }
}

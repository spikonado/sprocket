use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
struct ServerAddress {
    url: String,
}

pub struct ProfileLock {
    _file: File,
    directory: PathBuf,
}

impl ProfileLock {
    pub fn acquire(directory: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(directory)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join("server.lock"))?;
        file.try_lock().context(
            "another Sprocket server owns this data directory; connect to it or use a different SPROCKET_DATA_DIR",
        )?;
        #[cfg(windows)]
        remove_unreadable_private_files(directory);
        Ok(Self {
            _file: file,
            directory: directory.to_owned(),
        })
    }

    pub fn publish(&self, url: String) -> anyhow::Result<()> {
        write_private_file(
            &self.directory.join("server-address.json"),
            &serde_json::to_vec(&ServerAddress { url })?,
        )
    }
}

pub fn read_server_address(directory: &Path) -> anyhow::Result<Option<String>> {
    match std::fs::read(directory.join("server-address.json")) {
        Ok(bytes) => Ok(Some(serde_json::from_slice::<ServerAddress>(&bytes)?.url)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn write_private_file(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let parent = path.parent().context("file has no parent directory")?;
    std::fs::create_dir_all(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    restrict_windows_file(file.path())?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path)
        .context("failed to persist private file")?;
    #[cfg(unix)]
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(windows)]
pub fn restrict_windows_file(path: &Path) -> anyhow::Result<()> {
    use std::sync::OnceLock;
    static SDDL: OnceLock<String> = OnceLock::new();
    // Grant the user rather than OWNER RIGHTS: an elevated process makes
    // Administrators the owner, which would lock the user's normal runs out.
    let sddl = match SDDL.get() {
        Some(sddl) => sddl,
        None => {
            let sddl = format!("D:P(A;;FA;;;{})", current_user_sid()?);
            SDDL.get_or_init(|| sddl)
        }
    };
    set_windows_dacl(path, sddl)
}

#[cfg(windows)]
fn set_windows_dacl(path: &Path, sddl: &str) -> anyhow::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::{
        DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SetFileSecurityW,
    };
    let sddl: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: both strings are NUL-terminated; LocalFree releases the allocated descriptor.
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let result = SetFileSecurityW(
            path.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        );
        let error = (result == 0).then(std::io::Error::last_os_error);
        LocalFree(descriptor);
        if let Some(error) = error {
            return Err(error.into());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn current_user_sid() -> anyhow::Result<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    // SAFETY: the token handle is closed once read, the TOKEN_USER buffer is
    // u64-aligned and sized by the first call, and LocalFree releases the SID string.
    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut len = 0;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
        let mut buffer = vec![0u64; (len as usize).div_ceil(8)];
        let read = GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), len, &mut len);
        let error = (read == 0).then(std::io::Error::last_os_error);
        CloseHandle(token);
        if let Some(error) = error {
            return Err(error.into());
        }
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        let mut sid = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut sid) == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let sid_len = (0..).take_while(|&i| *sid.add(i) != 0).count();
        let text = String::from_utf16(std::slice::from_raw_parts(sid, sid_len));
        LocalFree(sid.cast());
        Ok(text?)
    }
}

/// Older releases restricted private files to OWNER RIGHTS, so files written by an
/// elevated run are unreadable to the user's normal runs. Their contents are lost
/// to this user either way; deleting them lets the server start and recreate them.
#[cfg(windows)]
fn remove_unreadable_private_files(directory: &Path) {
    let credential_dirs = std::fs::read_dir(directory.join("credentials"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path());
    for dir in std::iter::once(directory.to_owned()).chain(credential_dirs) {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            if File::open(&path)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied)
            {
                match std::fs::remove_file(&path) {
                    Ok(()) => tracing::warn!("removed unreadable private file {}", path.display()),
                    Err(error) => tracing::warn!(
                        "failed to remove unreadable file {}: {error}",
                        path.display()
                    ),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;

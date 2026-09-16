use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
struct ServerAddress {
    url: String,
}

pub(crate) struct ProfileLock {
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

pub(crate) fn write_private_file(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
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
    Ok(())
}

#[cfg(windows)]
pub(crate) fn restrict_windows_file(path: &Path) -> anyhow::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::{
        DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SetFileSecurityW,
    };
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let sddl: Vec<u16> = "D:P(A;;FA;;;OW)".encode_utf16().chain(Some(0)).collect();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_server_owns_a_profile_until_it_stops() {
        let dir = tempfile::tempdir().unwrap();
        let owner = ProfileLock::acquire(dir.path()).unwrap();
        assert!(ProfileLock::acquire(dir.path()).is_err());
        owner.publish("http://127.0.0.1:17731".into()).unwrap();
        assert_eq!(
            read_server_address(dir.path()).unwrap().as_deref(),
            Some("http://127.0.0.1:17731")
        );
        drop(owner);
        assert!(ProfileLock::acquire(dir.path()).is_ok());
    }
}

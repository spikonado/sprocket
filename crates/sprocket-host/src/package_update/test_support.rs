use super::*;

impl PackageUpdateManager {
    #[cfg(test)]
    pub(super) fn with_helper(node: PathBuf, script: PathBuf) -> Arc<Self> {
        Self::with_helper_and_timeouts(
            node,
            script,
            SUCCESS_CHECK_TTL,
            FAILED_CHECK_TTL,
            CHECK_TIMEOUT,
            INSTALL_TIMEOUT,
        )
    }

    pub fn with_helper_and_timeouts(
        node: PathBuf,
        script: PathBuf,
        success_ttl: Duration,
        failure_ttl: Duration,
        check_timeout: Duration,
        install_timeout: Duration,
    ) -> Arc<Self> {
        Arc::new(Self::new(
            Some(UpdateCommand { node, script }),
            success_ttl,
            failure_ttl,
            check_timeout,
            install_timeout,
        ))
    }
}

use napi_derive::napi;

#[napi]
pub fn get_runtime_info() -> String {
	format!(
		"napi-rs active on {} ({})",
		std::env::consts::OS,
		std::env::consts::ARCH
	)
}

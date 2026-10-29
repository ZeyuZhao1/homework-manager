mod db;
mod drive;
mod files;
mod import_sync;
mod modules;
mod printing;
mod window;
mod sync;
mod service_config;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = db::init(app.handle()).map_err(std::io::Error::other)?;
            app.manage(state);
            if let Some(window) = app.get_webview_window("main") {
                window::prepare_main_window(&window)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            drive::drive_request,
            drive::register_drive_files,
            sync::sync_recurring_action,
            sync::sync_status,
            sync::sync_open_service_config_directory,
            sync::sync_pair_start,
            sync::sync_pair_poll,
            sync::sync_bootstrap,
            sync::sync_set_enabled,
            sync::sync_now,
            sync::sync_devices,
            sync::sync_approve_pair,
            sync::sync_revoke_device,
            sync::sync_disconnect,
            sync::sync_upload_file,
            sync::sync_download_file,
            sync::sync_remove_cloud_file,
            printing::read_system_print_document,
            printing::show_system_print_dialog,
            db::load_snapshot,
            db::save_semester,
            db::delete_semester,
            db::save_course,
            db::save_assignment,
            db::save_assignments_batch,
            db::delete_assignment,
            db::save_settings,
            db::backup_database,
            db::restore_database,
            db::compact_database,
            import_sync::preview_assignment_import,
            import_sync::apply_assignment_import,
            files::link_file,
            files::link_files_batch,
            files::link_module_files,
            files::unlink_module_file,
            files::save_common_file,
            files::remove_common_file,
            files::open_file,
            files::open_file_directory,
            files::save_file_link,
            files::unlink_file,
            files::relink_file,
            files::browse_directory,
            files::search_course_files,
            files::preview_rename,
            files::rename_file,
            files::undo_rename,
            modules::list_modules,
            modules::set_module_enabled,
            modules::modules_directory,
            modules::open_modules_directory,
            modules::invoke_module,
            modules::manage_builtin_module,
            modules::assignment_import::get_config,
            modules::assignment_import::save_pasted_image,
            modules::assignment_import::save_provider,
            modules::assignment_import::delete_provider,
            modules::assignment_import::save_routing,
            modules::assignment_import::prompt_directory,
            modules::assignment_import::open_prompt_directory,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start 作业簿");
}

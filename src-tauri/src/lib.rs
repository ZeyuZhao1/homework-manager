mod db;
mod files;
mod import_sync;
mod modules;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = db::init(app.handle()).map_err(std::io::Error::other)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            modules::assignment_import::save_provider,
            modules::assignment_import::delete_provider,
            modules::assignment_import::save_routing,
            modules::assignment_import::prompt_directory,
            modules::assignment_import::open_prompt_directory,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start 作业簿");
}

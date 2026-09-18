mod ai;
mod db;
mod files;
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
            db::save_course,
            db::save_assignment,
            db::delete_assignment,
            db::save_settings,
            db::save_provider,
            db::delete_provider,
            db::backup_database,
            db::restore_database,
            db::compact_database,
            files::link_file,
            files::link_files_batch,
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
            modules::modules_directory,
            modules::open_modules_directory,
            modules::invoke_module,
            ai::save_import_drafts,
            ai::prompt_directory,
            ai::open_prompt_directory,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start 作业簿");
}

#[path = "assignment-import/backend.rs"]
pub mod assignment_import;
#[path = "recurring-assignments/backend.rs"]
mod recurring_assignments;

use crate::modules::BuiltinModuleRegistration;

pub fn registrations() -> [BuiltinModuleRegistration; 2] {
    [
        assignment_import::registration(),
        recurring_assignments::registration(),
    ]
}

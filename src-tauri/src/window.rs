use tauri::{LogicalSize, PhysicalPosition, PhysicalSize, WebviewWindow};

fn startup_size(work_area: PhysicalSize<u32>, scale: f64, frame: PhysicalSize<u32>) -> LogicalSize<f64> {
    // Reserve desktop space around the entire window, including its title bar.
    LogicalSize::new(
        ((work_area.width as f64 * 0.85 - frame.width as f64) / scale).clamp(1.0, 1200.0),
        ((work_area.height as f64 * 0.85 - frame.height as f64) / scale).clamp(1.0, 800.0),
    )
}

fn centered_position(origin: PhysicalPosition<i32>, area: PhysicalSize<u32>, window: PhysicalSize<u32>) -> PhysicalPosition<i32> {
    PhysicalPosition::new(
        origin.x + (area.width.saturating_sub(window.width) / 2) as i32,
        origin.y + (area.height.saturating_sub(window.height) / 2) as i32,
    )
}

pub fn prepare_main_window(window: &WebviewWindow) -> tauri::Result<()> {
    let monitor = match window.current_monitor()? {
        Some(monitor) => Some(monitor),
        None => window.primary_monitor()?,
    };
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        let outer = window.outer_size()?;
        let inner = window.inner_size()?;
        let frame = PhysicalSize::new(outer.width.saturating_sub(inner.width), outer.height.saturating_sub(inner.height));
        let size = startup_size(area.size, monitor.scale_factor(), frame);
        // A fixed minimum must not force a small or scaled screen toward full screen.
        window.set_min_size(Some(LogicalSize::new(size.width.min(980.0), size.height.min(650.0))))?;
        window.set_size(size)?;
        let outer = window.outer_size()?;
        window.set_position(centered_position(area.position, area.size, outer))?;
    } else {
        window.center()?;
    }
    window.show()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_screen_uses_moderate_logical_size() {
        let size = startup_size(PhysicalSize::new(2560, 1400), 1.0, PhysicalSize::new(16, 39));
        assert_eq!(size, LogicalSize::new(1200.0, 800.0));
    }

    #[test]
    fn small_and_scaled_screens_keep_space_for_window_frame() {
        for (width, height, scale) in [(1366, 728, 1.0), (1920, 1040, 1.5), (1920, 1040, 2.0)] {
            let frame = PhysicalSize::new(16, 39);
            let size = startup_size(PhysicalSize::new(width, height), scale, frame);
            assert!(size.width * scale + frame.width as f64 <= width as f64 * 0.85 + 0.01);
            assert!(size.height * scale + frame.height as f64 <= height as f64 * 0.85 + 0.01);
        }
    }

    #[test]
    fn centering_respects_taskbar_offset_and_negative_monitor_coordinates() {
        assert_eq!(
            centered_position(PhysicalPosition::new(48, 0), PhysicalSize::new(1872, 1080), PhysicalSize::new(1200, 800)),
            PhysicalPosition::new(384, 140),
        );
        assert_eq!(
            centered_position(PhysicalPosition::new(-1920, -1080), PhysicalSize::new(1920, 1040), PhysicalSize::new(1200, 800)),
            PhysicalPosition::new(-1560, -960),
        );
    }
}

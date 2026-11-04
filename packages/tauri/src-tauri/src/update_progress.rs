//! Taskbar presentation follows one original download lifetime, including a
//! dropped future. It never reports verification or installation success.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Progress {
    Hidden,
    Indeterminate,
    Percent(u64),
}

pub(crate) struct DownloadProgress<F: Fn(Progress)> {
    publish: F,
}

impl<F: Fn(Progress)> DownloadProgress<F> {
    pub(crate) fn new(publish: F) -> Self {
        publish(Progress::Indeterminate);
        Self { publish }
    }

    pub(crate) fn received(&self, downloaded: u64, total: Option<u64>) {
        let progress = match total.filter(|total| *total > 0) {
            Some(total) => Progress::Percent(
                ((u128::from(downloaded) * 100) / u128::from(total)).min(100) as u64,
            ),
            None => Progress::Indeterminate,
        };
        (self.publish)(progress);
    }
}

impl<F: Fn(Progress)> Drop for DownloadProgress<F> {
    fn drop(&mut self) {
        (self.publish)(Progress::Hidden);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn byte_progress_is_bounded_and_unknown_totals_remain_indeterminate() {
        let changes = RefCell::new(Vec::new());
        {
            let progress = DownloadProgress::new(|value| changes.borrow_mut().push(value));
            progress.received(25, Some(100));
            progress.received(1, None);
            progress.received(1, Some(0));
            progress.received(u64::MAX, Some(u64::MAX));
            progress.received(u64::MAX, Some(1));
        }
        assert_eq!(
            *changes.borrow(),
            [
                Progress::Indeterminate,
                Progress::Percent(25),
                Progress::Indeterminate,
                Progress::Indeterminate,
                Progress::Percent(100),
                Progress::Percent(100),
                Progress::Hidden,
            ]
        );
    }

    #[test]
    fn failed_download_and_cancelled_future_clear_the_original_progress() {
        let changes = RefCell::new(Vec::new());
        let fail = || -> Result<(), ()> {
            let _progress = DownloadProgress::new(|value| changes.borrow_mut().push(value));
            Err(())?;
            Ok(())
        };
        assert_eq!(fail(), Err(()));
        assert_eq!(
            *changes.borrow(),
            [Progress::Indeterminate, Progress::Hidden]
        );

        changes.borrow_mut().clear();
        let mut future = Box::pin(async {
            let _progress = DownloadProgress::new(|value| changes.borrow_mut().push(value));
            std::future::pending::<()>().await;
        });
        let waker = std::task::Waker::noop();
        let mut context = std::task::Context::from_waker(waker);
        assert!(std::future::Future::poll(future.as_mut(), &mut context).is_pending());
        drop(future);
        assert_eq!(
            *changes.borrow(),
            [Progress::Indeterminate, Progress::Hidden]
        );
    }
}

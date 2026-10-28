# Screen-gaze shared-baseline hand motion

- `canonical-typing-v2`, `canonical-scroll-v2`, `canonical-key-tap-v2` use the actual screen-directed eye artwork from OBSERVE; the original canonical neutral face is not mislabeled as looking at the computer.
- Runtime entry/exit name: `seated-open-screen-keyboard`. It must connect to the neutral/user-directed pose through the explicit gaze bridge, not by relabeling the eye direction.
- First and last PNGs exactly match the shared read-screen artwork. The build asserts all non-hand pixels are unchanged from that source, avoiding the mixed historical alpha issue documented separately.
- Real local hand redrawing is reused from prior sources. No artificial whole-body motion is inserted; reading/observation/rest and attention segments provide the broader performance around these small operations.
- Scroll was internally reviewed at actual 320 px and 1x before the eye correction: finger motion was subtle but readable, with stable body/computer/sleeves. This does not mark all combined animations production accepted.
- Source timing: typing 990 ms, scroll 1220 ms, key-tap 640 ms, explicit millisecond frames and no looping assumption. These are small operation segments, not an endless busy-keyboard state.
- Opening/closing work remains in a separate art/geometry production folder. It is not included in this completed source freeze or counted as accepted by it.

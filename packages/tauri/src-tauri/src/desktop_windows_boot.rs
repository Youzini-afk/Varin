//! Read-only Windows reboot evidence. Job names are not lifetime receipts: the
//! object manager may remove a name before the last object reference is gone.
//! Only a later documented BootId on the same SMBIOS machine retires unfinished
//! scope records; it never fabricates a successful drain.
use crate::desktop_lock::Record;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

const FILE: &str = "windows-boot-session.json";
const SOURCE: &str = "windows-smbios-prefetch-boot-v1";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Identity {
    host_uuid: String,
    boot_id: u32,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proof {
    schema: u32,
    source: String,
    owner_token: String,
    owner_pid: u32,
    identity: Identity,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Relation {
    Unrecorded,
    Current,
    Previous,
}

fn valid_host(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| {
        !id.is_nil() && id.as_bytes() != &[0xff; 16] && id.hyphenated().to_string() == value
    })
}
pub(crate) fn relation(
    root: &Path,
    owner: &Record,
    current: Option<&Identity>,
) -> Result<Relation, String> {
    let path = root.join(FILE);
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Relation::Unrecorded);
        }
        Err(_) => return Err("Windows boot evidence cannot be inspected".into()),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 4096 {
        return Err("Windows boot evidence is invalid".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "Windows boot evidence cannot be read")?
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| "Windows boot evidence cannot be read")?;
    if bytes.len() > 4096 {
        return Err("Windows boot evidence is invalid".into());
    }
    let proof: Proof =
        serde_json::from_slice(&bytes).map_err(|_| "Windows boot evidence is invalid")?;
    if proof.schema != 1
        || proof.source != SOURCE
        || proof.owner_token != owner.token
        || proof.owner_pid != owner.pid
        || !valid_host(&proof.identity.host_uuid)
    {
        return Err("Windows boot evidence does not match its original owner".into());
    }
    let current = current.ok_or(
        "Current Windows host/boot evidence is unavailable; original ownership is retained",
    )?;
    if !valid_host(&current.host_uuid) || current.host_uuid != proof.identity.host_uuid {
        return Err("Windows desktop data belongs to another or unconfirmed host; original ownership is retained".into());
    }
    match current.boot_id.cmp(&proof.identity.boot_id) {
        std::cmp::Ordering::Equal => Ok(Relation::Current),
        std::cmp::Ordering::Greater => Ok(Relation::Previous),
        std::cmp::Ordering::Less => {
            Err("Windows boot counter moved backwards; original ownership is retained".into())
        }
    }
}
pub(crate) fn write(root: &Path, owner: &Record, identity: &Identity) -> Result<(), String> {
    if !valid_host(&identity.host_uuid) {
        return Err("Windows host identity is invalid".into());
    }
    let proof = Proof {
        schema: 1,
        source: SOURCE.into(),
        owner_token: owner.token.clone(),
        owner_pid: owner.pid,
        identity: identity.clone(),
    };
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(root.join(FILE))
        .map_err(|_| "Windows boot evidence could not be prepared")?;
    file.write_all(&serde_json::to_vec(&proof).map_err(|_| "Windows boot evidence is invalid")?)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Windows boot evidence could not be committed".into())
}

#[cfg(not(windows))]
pub(crate) fn current() -> Option<Identity> {
    None
}

#[cfg(windows)]
pub(crate) fn current() -> Option<Identity> {
    use windows_sys::Win32::System::{
        Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_SUBKEY_WOW6464KEY, RegGetValueW},
        SystemInformation::{GetSystemFirmwareTable, RSMB},
    };
    // BootId increments on each successful boot. Do not substitute uptime,
    // wall-clock estimates, user logon identities, or an undocumented NT layout.
    // https://learn.microsoft.com/windows-hardware/design/device-experiences/oem-hvci-enablement
    let key: Vec<u16> = "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters\0".encode_utf16().collect();
    let value: Vec<u16> = "BootId\0".encode_utf16().collect();
    let mut boot_id = 0u32;
    let mut size = std::mem::size_of_val(&boot_id) as u32;
    if unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY,
            std::ptr::null_mut(),
            (&mut boot_id as *mut u32).cast(),
            &mut size,
        )
    } != 0
        || size != 4
    {
        return None;
    }
    // The provider supplies a byte length, not a count of structures. The second
    // read must match exactly; changed/unavailable firmware grants no recovery.
    let size = unsafe { GetSystemFirmwareTable(RSMB, 0, std::ptr::null_mut(), 0) };
    if size < 8 {
        return None;
    }
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(size as usize).ok()?;
    bytes.resize(size as usize, 0);
    if unsafe { GetSystemFirmwareTable(RSMB, 0, bytes.as_mut_ptr(), size) } != size {
        return None;
    }
    Some(Identity {
        host_uuid: smbios_uuid(&bytes)?,
        boot_id,
    })
}

#[cfg(any(windows, test))]
fn smbios_uuid(raw: &[u8]) -> Option<String> {
    // RawSMBIOSData's eight-byte header is documented by GetSystemFirmwareTable.
    // Type 1 UUID is at offset 8, length 16. SMBIOS 2.6+ specifies GUID byte order.
    // https://learn.microsoft.com/windows/win32/api/sysinfoapi/nf-sysinfoapi-getsystemfirmwaretable
    // https://learn.microsoft.com/windows-hardware/drivers/bringup/smbios
    if raw.len() < 8 || (raw[1], raw[2]) < (2, 6) {
        return None;
    }
    let length = u32::from_le_bytes(raw[4..8].try_into().ok()?) as usize;
    if length != raw.len().checked_sub(8)? {
        return None;
    }
    let mut table = &raw[8..];
    let mut found = None;
    while !table.is_empty() {
        if table.len() < 4 {
            return None;
        }
        let kind = table[0];
        let length = usize::from(table[1]);
        if length < 4 || length > table.len() {
            return None;
        }
        if kind == 1 {
            if length < 24 || found.is_some() {
                return None;
            }
            let bytes: [u8; 16] = table[8..24].try_into().ok()?;
            if bytes == [0; 16] || bytes == [0xff; 16] {
                return None;
            }
            found = Some(uuid::Uuid::from_bytes_le(bytes).hyphenated().to_string());
        }
        let strings = &table[length..];
        let end = strings.windows(2).position(|pair| pair == [0, 0])?;
        table = &strings[end + 2..];
        if kind == 127 {
            // Padding is allowed, but no hidden second Type 1 or extra record.
            if table.iter().any(|byte| *byte != 0) {
                return None;
            }
            return found;
        }
    }
    // Modern SMBIOS tables must include the end-of-table structure.
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    fn host() -> String {
        "00112233-4455-6677-8899-aabbccddeeff".into()
    }
    fn record() -> Record {
        Record {
            schema: 1,
            pid: std::process::id(),
            token: uuid::Uuid::new_v4().to_string(),
            shell: "tauri".into(),
        }
    }
    fn firmware(table: Vec<u8>) -> Vec<u8> {
        let mut raw = vec![0, 3, 0, 0];
        raw.extend_from_slice(&(table.len() as u32).to_le_bytes());
        raw.extend(table);
        raw
    }
    fn system(bytes: [u8; 16]) -> Vec<u8> {
        let mut row = vec![1, 24, 0, 0, 0, 0, 0, 0];
        row.extend(bytes);
        row.extend([0, 0]);
        row
    }
    #[test]
    fn parses_original_firmware_uuid_without_accepting_ambiguous_tables() {
        let uuid = uuid::Uuid::parse_str(&host()).unwrap();
        let row = system(uuid.to_bytes_le());
        let end = [127, 4, 1, 0, 0, 0];
        let raw = firmware([row.clone(), end.to_vec()].concat());
        assert_eq!(smbios_uuid(&raw).as_deref(), Some(host().as_str()));
        for malformed in [
            firmware([row.clone(), row.clone(), end.to_vec()].concat()),
            firmware([system([0; 16]), end.to_vec()].concat()),
            firmware([system([0xff; 16]), end.to_vec()].concat()),
            firmware(row.clone()),
            firmware(end.to_vec()),
        ] {
            assert!(smbios_uuid(&malformed).is_none());
        }
        for count in 0..raw.len() {
            assert!(smbios_uuid(&raw[..count]).is_none());
        }
        let mut older = raw.clone();
        older[1] = 2;
        older[2] = 5;
        assert!(smbios_uuid(&older).is_none());
        let mut length = raw.clone();
        length[9] = 3;
        assert!(smbios_uuid(&length).is_none());
    }
    #[test]
    fn only_same_host_and_strictly_later_counter_prove_reboot() {
        let root = tempfile::tempdir().unwrap();
        let owner = record();
        let old = Identity {
            host_uuid: host(),
            boot_id: 21,
        };
        assert_eq!(
            relation(root.path(), &owner, Some(&old)).unwrap(),
            Relation::Unrecorded
        );
        write(root.path(), &owner, &old).unwrap();
        assert_eq!(
            relation(root.path(), &owner, Some(&old)).unwrap(),
            Relation::Current
        );
        assert_eq!(
            relation(
                root.path(),
                &owner,
                Some(&Identity {
                    boot_id: 22,
                    ..old.clone()
                })
            )
            .unwrap(),
            Relation::Previous
        );
        assert!(
            relation(
                root.path(),
                &owner,
                Some(&Identity {
                    boot_id: 20,
                    ..old.clone()
                })
            )
            .is_err()
        );
        assert!(
            relation(
                root.path(),
                &owner,
                Some(&Identity {
                    host_uuid: uuid::Uuid::new_v4().to_string(),
                    boot_id: 22
                })
            )
            .is_err()
        );
        assert!(relation(root.path(), &owner, None).is_err());
        assert!(relation(root.path(), &record(), Some(&old)).is_err());
    }
    #[test]
    fn unknown_malformed_or_owner_mismatched_proofs_are_retained() {
        let root = tempfile::tempdir().unwrap();
        let owner = record();
        let old = Identity {
            host_uuid: host(),
            boot_id: 21,
        };
        write(root.path(), &owner, &old).unwrap();
        let path = root.path().join(FILE);
        let original: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        for (key, value) in [
            ("schema", serde_json::json!(2)),
            ("source", serde_json::json!("uptime")),
            ("ownerPid", serde_json::json!(0)),
            (
                "ownerToken",
                serde_json::json!(uuid::Uuid::new_v4().to_string()),
            ),
            ("extra", serde_json::json!(true)),
            (
                "identity",
                serde_json::json!({"hostUuid":host(),"bootId":-1}),
            ),
        ] {
            let mut changed = original.clone();
            changed[key] = value;
            let bytes = serde_json::to_vec(&changed).unwrap();
            fs::write(&path, &bytes).unwrap();
            assert!(relation(root.path(), &owner, Some(&old)).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        fs::write(&path, b"{").unwrap();
        assert!(relation(root.path(), &owner, Some(&old)).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn native_windows_host_and_boot_reads_are_stable() {
        let first =
            current().expect("Windows qualification requires readable SMBIOS UUID and BootId");
        assert_eq!(current(), Some(first.clone()));
        let root = tempfile::tempdir().unwrap();
        let owner = record();
        write(root.path(), &owner, &first).unwrap();
        assert_eq!(
            relation(root.path(), &owner, current().as_ref()).unwrap(),
            Relation::Current
        );
    }
}

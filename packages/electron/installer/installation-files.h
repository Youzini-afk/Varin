// Installation files are moved on their own volume before removal. A failed
// move restores the original tree; reparse points are moved as links.
#include <vector>

static std::wstring extendedPath(const std::wstring& path) {
  if (path.rfind(L"\\\\?\\", 0) == 0) return path;
  return path.rfind(L"\\\\", 0) == 0 ? L"\\\\?\\UNC\\" + path.substr(2) : L"\\\\?\\" + path;
}

struct InstallationRemoval {
  std::wstring source, staging, failedPath;
  std::vector<std::wstring> moved, directories;
  DWORD failure = 0;

  bool fail(const std::wstring& path, DWORD error = GetLastError()) {
    if (!failure) { failure = error; failedPath = path; }
    return false;
  }

  bool stage(const std::wstring& relative) {
    const auto from = source + relative, to = staging + relative;
    const DWORD attributes = GetFileAttributesW(from.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) return fail(from);
    if (!(attributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
      if (!MoveFileExW(from.c_str(), to.c_str(), 0)) return fail(from);
      moved.push_back(relative);
      return true;
    }
    if (!relative.empty() && !CreateDirectoryW(to.c_str(), nullptr)) return fail(to);
    directories.push_back(relative);
    WIN32_FIND_DATAW item{};
    HANDLE search = FindFirstFileW((from + L"\\*").c_str(), &item);
    if (search == INVALID_HANDLE_VALUE) {
      const DWORD error = GetLastError();
      return error == ERROR_FILE_NOT_FOUND || fail(from, error);
    }
    do {
      if (wcscmp(item.cFileName, L".") && wcscmp(item.cFileName, L".."))
        if (!stage(relative + L"\\" + item.cFileName)) break;
    } while (FindNextFileW(search, &item));
    const DWORD error = GetLastError();
    FindClose(search);
    if (!failure && error != ERROR_NO_MORE_FILES) fail(from, error);
    return !failure;
  }

  bool restore(bool deleted = false) {
    DWORD restoreFailure = 0;
    std::wstring restorePath;
    for (const auto& relative : directories) {
      const auto path = source + relative;
      if (!CreateDirectoryW(path.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS && !restoreFailure) {
        restoreFailure = GetLastError(); restorePath = path;
      }
    }
    for (auto file = moved.rbegin(); file != moved.rend(); ++file) {
      if (deleted && GetFileAttributesW((staging + *file).c_str()) == INVALID_FILE_ATTRIBUTES &&
          (GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND)) continue;
      if (!MoveFileExW((staging + *file).c_str(), (source + *file).c_str(), 0) && !restoreFailure) {
        restoreFailure = GetLastError(); restorePath = source + *file;
      }
    }
    // Delete only empty staging directories. Never delete an unrestored file.
    for (auto directory = directories.rbegin(); directory != directories.rend(); ++directory)
      RemoveDirectoryW((staging + *directory).c_str());
    RemoveDirectoryW(staging.c_str());
    if (restoreFailure) {
      failedPath += L"\r\n" + restorePath + L": " + systemError(restoreFailure) + L"\r\n" + staging;
      return false;
    }
    return true;
  }

  void run() {
    if (!stage(L"")) { restore(); return; }
    // A newly created file stops removal and is preserved. This pass removes
    // directories only, so it cannot silently delete concurrent new content.
    for (auto directory = directories.rbegin(); directory != directories.rend(); ++directory) {
      const auto path = source + *directory;
      if (!RemoveDirectoryW(path.c_str())) { fail(path); restore(); return; }
    }
    removeTree(staging, failure, failedPath);
    // A removal failure keeps surviving files at the known installation path
    // so retry can finish cleanup without abandoning a hidden staging tree.
    if (failure) restore(true);
  }
};

extern "C" __declspec(dllexport) void __cdecl RemoveInstall(HWND, int size, wchar_t*, Stack** stack, void*) {
  Call call{size, stack};
  const auto input = call.pop();
  const bool drive = input.size() >= 3 && input[1] == L':' && (input[2] == L'\\' || input[2] == L'/');
  if (!drive && input.rfind(L"\\\\", 0) != 0) {
    call.push(input + L": " + systemError(ERROR_INVALID_NAME)); call.push(std::to_wstring(ERROR_INVALID_NAME)); return;
  }
  DWORD length = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr);
  std::wstring absolute(length, L'\0');
  DWORD written = length ? GetFullPathNameW(input.c_str(), length, absolute.data(), nullptr) : 0;
  if (!written || written >= length) {
    call.push(systemError(ERROR_INVALID_NAME)); call.push(std::to_wstring(ERROR_INVALID_NAME)); return;
  }
  absolute.resize(written);
  while (!absolute.empty() && absolute.back() == L'\\') absolute.pop_back();
  const auto separator = absolute.find_last_of(L'\\');
  // Only an installation directory is eligible, never a drive/share root.
  const auto share = absolute.rfind(L"\\\\", 0) == 0 ? absolute.find(L'\\', absolute.find(L'\\', 2) + 1) : 0;
  if (separator == std::wstring::npos || separator < 2 || (share == std::wstring::npos) ||
      (absolute.rfind(L"\\\\?\\", 0) == 0) || (absolute.rfind(L"\\\\.\\", 0) == 0)) {
    call.push(input + L": " + systemError(ERROR_INVALID_NAME)); call.push(std::to_wstring(ERROR_INVALID_NAME)); return;
  }
  InstallationRemoval removal;
  removal.source = extendedPath(absolute);
  const DWORD attributes = GetFileAttributesW(removal.source.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) {
    const DWORD error = GetLastError();
    if (error == ERROR_PATH_NOT_FOUND || error == ERROR_FILE_NOT_FOUND) { call.push(L""); call.push(L"0"); return; }
    removal.fail(absolute, error);
  } else if (!(attributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    removal.fail(absolute, ERROR_INVALID_PARAMETER);
  } else {
    GUID id{};
    const HRESULT result = CoCreateGuid(&id);
    wchar_t guid[40]{};
    if (FAILED(result) || !StringFromGUID2(id, guid, static_cast<int>(std::size(guid)))) {
      removal.fail(absolute, ERROR_GEN_FAILURE);
    } else {
      removal.staging = extendedPath(absolute.substr(0, separator + 1) + L".varin-remove-" + guid);
      if (!CreateDirectoryW(removal.staging.c_str(), nullptr)) removal.fail(removal.staging);
      else removal.run();
    }
  }
  call.push(removal.failure ? removal.failedPath + L": " + systemError(removal.failure) : L"");
  call.push(std::to_wstring(removal.failure));
}

/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// An Emscripten JS library (not an ES module, so not .js): a file system whose
// files are origin private file system sync access handles, which a dedicated
// worker opens before mounting them. Reads go straight from the file into the
// heap, so hoshidicts' paged storage reads only the pages a lookup needs.
//
// FS.mount(OPFSFS, {files: [{name, handle}]}, '/some/directory')
//
// A mount the program writes to also takes newFiles: creating a file of one of
// those names, in any directory of the mount, gives it that handle. Creating a
// file is synchronous and opening a handle is not, so the handles have to be
// opened beforehand. Directories live only in memory. Anything that reads like
// a sync access handle can stand in for one, such as an object over bytes that
// are already in memory.
//
// FS.mount(OPFSFS, {files: [], newFiles: [{name, handle}]}, '/some/directory')
//
// A handle with an advise(offset, length) method is told of the ranges the
// program will read soon, which it says with posix_fadvise(POSIX_FADV_WILLNEED),
// so that it can read them together.

addToLibrary({
    $OPFSFS__deps: ['$FS', '$mmapAlloc'],
    $OPFSFS: {
        DIR_MODE: {{{ cDefs.S_IFDIR | 0o555 }}},
        WRITABLE_DIR_MODE: {{{ cDefs.S_IFDIR | 0o755 }}},
        FILE_MODE: {{{ cDefs.S_IFREG | 0o444 }}},
        mount(mount) {
            var newFiles = mount.opts['newFiles'] ?? [];
            mount.newFiles = new Map(newFiles.map((file) => [file['name'], file['handle']]));
            var root = OPFSFS.createNode(null, '/', newFiles.length > 0 ? OPFSFS.WRITABLE_DIR_MODE : OPFSFS.DIR_MODE, null);
            for (var file of mount.opts['files']) {
                OPFSFS.createNode(root, file['name'], OPFSFS.FILE_MODE, file['handle']);
            }
            return root;
        },
        createNode(parent, name, mode, handle, writable = false) {
            var node = FS.createNode(parent, name, mode);
            node.node_ops = OPFSFS.node_ops;
            node.stream_ops = OPFSFS.stream_ops;
            node.atime = node.mtime = node.ctime = Date.now();
            if (handle !== null) {
                node.handle = handle;
                node.writable = writable;
                node.size = handle.getSize();
            } else {
                node.size = 4096;
                node.contents = {};
            }
            if (parent) {
                parent.contents[name] = node;
            }
            return node;
        },
        node_ops: {
            getattr(node) {
                return {
                    dev: 1,
                    ino: node.id,
                    mode: node.mode,
                    nlink: 1,
                    uid: 0,
                    gid: 0,
                    rdev: 0,
                    size: node.size,
                    atime: new Date(node.atime),
                    mtime: new Date(node.mtime),
                    ctime: new Date(node.ctime),
                    blksize: 4096,
                    blocks: Math.ceil(node.size / 4096),
                };
            },
            setattr(node, attr) {
                if (attr.size !== undefined) {
                    if (!node.writable) {
                        throw new FS.ErrnoError({{{ cDefs.EPERM }}});
                    }
                    node.handle.truncate(attr.size);
                    node.size = attr.size;
                }
                for (var key of ['mode', 'atime', 'mtime', 'ctime']) {
                    if (attr[key] != null) {
                        node[key] = attr[key];
                    }
                }
            },
            // Every node is created up front or by mknod, which FS finds by name before asking here.
            lookup(parent, name) {
                throw new FS.ErrnoError({{{ cDefs.ENOENT }}});
            },
            mknod(parent, name, mode, dev) {
                if (FS.isDir(mode)) {
                    return OPFSFS.createNode(parent, name, mode, null);
                }
                var newFiles = parent.mount.newFiles;
                var handle = FS.isFile(mode) ? newFiles.get(name) : undefined;
                if (handle === undefined) {
                    err(`OPFSFS: no file was opened for ${name}`);
                    throw new FS.ErrnoError({{{ cDefs.EPERM }}});
                }
                newFiles.delete(name);
                handle.truncate(0);
                return OPFSFS.createNode(parent, name, mode, handle, true);
            },
            rename(oldNode, newDir, newName) {
                throw new FS.ErrnoError({{{ cDefs.EPERM }}});
            },
            // A removed file's handle can be created again.
            unlink(parent, name) {
                var node = parent.contents[name];
                if (!node.writable) {
                    throw new FS.ErrnoError({{{ cDefs.EPERM }}});
                }
                node.handle.truncate(0);
                parent.mount.newFiles.set(name, node.handle);
                delete parent.contents[name];
            },
            rmdir(parent, name) {
                var node = parent.contents[name];
                if (Object.keys(node.contents).length > 0) {
                    throw new FS.ErrnoError({{{ cDefs.ENOTEMPTY }}});
                }
                delete parent.contents[name];
            },
            readdir(node) {
                return ['.', '..', ...Object.keys(node.contents)];
            },
            symlink(parent, newName, oldPath) {
                throw new FS.ErrnoError({{{ cDefs.EPERM }}});
            },
        },
        stream_ops: {
            read(stream, buffer, offset, length, position) {
                var size = stream.node.size;
                if (position >= size) { return 0; }
                length = Math.min(length, size - position);
                return stream.node.handle.read(buffer.subarray(offset, offset + length), {at: position});
            },
            write(stream, buffer, offset, length, position) {
                var node = stream.node;
                if (!node.writable) {
                    throw new FS.ErrnoError({{{ cDefs.EPERM }}});
                }
                var written = node.handle.write(buffer.subarray(offset, offset + length), {at: position});
                node.size = Math.max(node.size, position + written);
                node.mtime = node.ctime = Date.now();
                return written;
            },
            llseek(stream, offset, whence) {
                var position = offset;
                if (whence === {{{ cDefs.SEEK_CUR }}}) {
                    position += stream.position;
                } else if (whence === {{{ cDefs.SEEK_END }}}) {
                    position += stream.node.size;
                }
                if (position < 0) {
                    throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
                }
                return position;
            },
            // Emscripten has no demand paging: a mapping is a copy, which msync writes back.
            mmap(stream, length, position, prot, flags) {
                if ((prot & {{{ cDefs.PROT_WRITE }}}) && !stream.node.writable) {
                    throw new FS.ErrnoError({{{ cDefs.EACCES }}});
                }
                var ptr = mmapAlloc(length);
                if (!ptr) {
                    throw new FS.ErrnoError({{{ cDefs.ENOMEM }}});
                }
                var available = Math.max(0, Math.min(length, stream.node.size - position));
                stream.node.handle.read(HEAPU8.subarray(ptr, ptr + available), {at: position});
                return {ptr, allocated: true};
            },
            msync(stream, buffer, offset, length, mmapFlags) {
                if (stream.node.writable && (stream.flags & {{{ cDefs.O_ACCMODE }}}) !== {{{ cDefs.O_RDONLY }}}) {
                    OPFSFS.stream_ops.write(stream, buffer, 0, length, offset);
                }
                return 0;
            },
        },
    },
    // In place of Emscripten's, which does nothing with the advice.
    __syscall_fadvise64__deps: ['$SYSCALLS'],
    __syscall_fadvise64__i53abi: true,
    __syscall_fadvise64: (fd, offset, len, advice) => {
        var stream = SYSCALLS.getStreamFromFD(fd);
        if (!stream.seekable) {
            return -{{{ cDefs.ESPIPE }}};
        }
        // POSIX_FADV_WILLNEED
        if (advice === 3 && typeof stream.node.handle?.advise === 'function') {
            stream.node.handle.advise(offset, len);
        }
        return 0;
    },
});

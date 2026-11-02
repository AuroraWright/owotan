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

// An Emscripten JS library (not an ES module, so not .js): a read-only file system whose
// files are origin private file system sync access handles, which a dedicated
// worker opens before mounting them. Reads go straight from the file into the
// heap, so hoshidicts' paged storage reads only the pages a lookup needs.
//
// FS.mount(OPFSFS, {files: [{name, handle}]}, '/some/directory')

addToLibrary({
    $OPFSFS__deps: ['$FS', '$mmapAlloc'],
    $OPFSFS: {
        DIR_MODE: {{{ cDefs.S_IFDIR | 0o555 }}},
        FILE_MODE: {{{ cDefs.S_IFREG | 0o444 }}},
        mount(mount) {
            var root = OPFSFS.createNode(null, '/', OPFSFS.DIR_MODE, null);
            for (var file of mount.opts['files']) {
                OPFSFS.createNode(root, file['name'], OPFSFS.FILE_MODE, file['handle']);
            }
            return root;
        },
        createNode(parent, name, mode, handle) {
            var node = FS.createNode(parent, name, mode);
            node.node_ops = OPFSFS.node_ops;
            node.stream_ops = OPFSFS.stream_ops;
            node.atime = node.mtime = node.ctime = Date.now();
            if (handle !== null) {
                node.handle = handle;
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
                throw new FS.ErrnoError({{{ cDefs.EPERM }}});
            },
            lookup(parent, name) {
                throw new FS.ErrnoError({{{ cDefs.ENOENT }}});
            },
            mknod(parent, name, mode, dev) {
                throw new FS.ErrnoError({{{ cDefs.EPERM }}});
            },
            rename(oldNode, newDir, newName) {
                throw new FS.ErrnoError({{{ cDefs.EPERM }}});
            },
            unlink(parent, name) {
                throw new FS.ErrnoError({{{ cDefs.EPERM }}});
            },
            rmdir(parent, name) {
                throw new FS.ErrnoError({{{ cDefs.EPERM }}});
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
                throw new FS.ErrnoError({{{ cDefs.EPERM }}});
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
            // Emscripten has no demand paging: a mapping is a copy.
            mmap(stream, length, position, prot, flags) {
                if (prot & {{{ cDefs.PROT_WRITE }}}) {
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
                return 0;
            },
        },
    },
});

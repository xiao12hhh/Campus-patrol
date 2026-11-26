# Campus pedestrians

Sources: user-supplied `0d84c64aea3136efa1a91aa4129687e2.rar` and `73af9d7d2391cf0ff92b6190481039fb.rar`.

Both archives contain static OBJ geometry and PBR textures, without skeletons or animation clips. Runtime models retain the supplied albedo artwork, use 1024-pixel JPEG albedo maps, geometry normals, meshopt compression, and mesh simplification. The normal/metallic/roughness image maps are omitted to reduce memory use for crowds; a rough nonmetallic material is used. Model A retains 16,746 triangles, model B 5,998. Shared geometry and textures are reused across pedestrians.

Runtime height is 1.78 m for A, 1.72 m for B (scene scale: one unit = 10 m). Walking is a modest procedural vertex deformation, not authored skeletal animation. Original archives remain local and are excluded from Git; no license terms were provided in the archives.

Rebuild with `tools/prepare_people.ps1` from the repository root.

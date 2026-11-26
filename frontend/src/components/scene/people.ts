import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

let pending: Promise<THREE.Group[]> | undefined;
export function loadPeople() {
  return pending ??= Promise.all(['a','b'].map(async id=>{
    const loader=new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const {scene}=await loader.loadAsync(`/models/people/person-${id}.glb`);
    scene.updateMatrixWorld(true);
    const box=new THREE.Box3().setFromObject(scene), height=box.max.y-box.min.y;
    const center=box.getCenter(new THREE.Vector3());
    const root=new THREE.Group();
    scene.traverse(o=>{
      if(!(o instanceof THREE.Mesh)) return;
      const geometry=o.geometry.clone();
      const p=geometry.getAttribute('position'), n=geometry.getAttribute('normal');
      const positions=[], normals=[];
      const normalMatrix=new THREE.Matrix3().getNormalMatrix(o.matrixWorld);
      for(let i=0;i<p.count;i++) {
        const v=new THREE.Vector3().fromBufferAttribute(p,i).applyMatrix4(o.matrixWorld);
        positions.push((v.x-center.x)/height,(v.y-box.min.y)/height,(v.z-center.z)/height);
        if(n){const normal=new THREE.Vector3().fromBufferAttribute(n,i).applyNormalMatrix(normalMatrix);normals.push(normal.x,normal.y,normal.z);}
      }
      geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
      if(n)geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
      geometry.computeBoundingBox();geometry.computeBoundingSphere();
      const material=(o.material as THREE.MeshStandardMaterial).clone();
      material.roughness=.85;material.metalness=0;
      const mesh=new THREE.Mesh(geometry,material);mesh.castShadow=true;mesh.receiveShadow=true;root.add(mesh);
    });
    return root;
  }));
}

/** OBJ has no rig: modest vertex deformation supplies a lightweight walking approximation. */
export function makePerson(prototype: THREE.Group, variant:number) {
  const visual=prototype.clone(true);
  visual.name='person-model';visual.scale.setScalar(variant===0?.178:.172);
  const phase={value:0}, strength={value:0};
  visual.traverse(o=>{
    if(!(o instanceof THREE.Mesh))return;
    const material=(o.material as THREE.MeshStandardMaterial).clone();
    material.onBeforeCompile=shader=>{
      shader.uniforms.walkPhase=phase;shader.uniforms.walkStrength=strength;
      shader.vertexShader='uniform float walkPhase;\nuniform float walkStrength;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
        float side=position.x<0.0 ? -1.0 : 1.0;
        float swing=sin(walkPhase)*side*walkStrength;
        float leg=1.0-smoothstep(0.32,0.52,position.y);
        transformed.z+=swing*0.085*leg;
        transformed.y+=max(0.0,swing)*0.025*leg;
      `);
    };
    material.customProgramCacheKey=()=> 'people-walk-v1';
    o.material=material;
    // Shader-deformed feet require the same displacement in the shadow pass.
    const depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking});
    depth.onBeforeCompile=material.onBeforeCompile;depth.customProgramCacheKey=material.customProgramCacheKey;
    o.customDepthMaterial=depth;
  });
  visual.userData.walkPhase=phase;visual.userData.walkStrength=strength;
  visual.userData.variant=variant;
  return visual;
}

export function releasePerson(person:THREE.Object3D) {
  // Geometry and textures belong to the shared prototypes, never dispose them per person.
  person.traverse(o=>{if(o instanceof THREE.Mesh){(o.material as THREE.Material).dispose();o.customDepthMaterial?.dispose();}});
}

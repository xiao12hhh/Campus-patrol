import * as THREE from 'three';
import { makeLabelSprite } from './builders';

export function navigationDecor(state: any, demonstration: boolean, ground: (x:number,z:number)=>number) {
  const group = new THREE.Group(); group.name = 'navigation-decor';
  function label(text: string, x: number, z: number) {
    const sprite = makeLabelSprite(text);
    sprite.scale.set(.8, .14, 1); sprite.position.set(x, ground(x,z)+.38, z);
    group.add(sprite);
  }
  function ring(x: number, z: number, radius: number, color: number) {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(radius, radius+.025, 48), new THREE.MeshBasicMaterial({ color, transparent:true, opacity:.8, side:THREE.DoubleSide, depthWrite:false }));
    mesh.rotation.x=-Math.PI/2; mesh.position.set(x,ground(x,z)+.008,z);group.add(mesh);
  }
  for (const o of state?.obstacles || []) {
    if(o.kind === '行人') { if(demonstration) ring(o.x,o.z,o.radius+.35,0xffbd70); continue; }
    ring(o.x,o.z,o.radius,0xff9d42);
    const orange = new THREE.MeshStandardMaterial({color:0xf18536,roughness:.8});
    const white = new THREE.MeshStandardMaterial({color:0xfff3dd,roughness:.85});
    for(let i=0;i<8;i++) {
      const a=i*Math.PI/4, x=o.x+Math.cos(a)*o.radius, z=o.z+Math.sin(a)*o.radius;
      const cone=new THREE.Mesh(new THREE.ConeGeometry(.025,.08,12),orange);cone.position.set(x,ground(x,z)+.045,z);cone.castShadow=true;
      const stripe=new THREE.Mesh(new THREE.CylinderGeometry(.014,.019,.018,12),white);stripe.position.set(x,ground(x,z)+.047,z);
      const base=new THREE.Mesh(new THREE.BoxGeometry(.065,.009,.065),orange);base.position.set(x,ground(x,z)+.01,z);group.add(cone,stripe,base);
    }
    const board = new THREE.Mesh(new THREE.BoxGeometry(o.radius*1.4,.08,.025),orange);
    board.position.set(o.x,ground(o.x,o.z)+.09,o.z);board.castShadow=true;group.add(board);
    for(let i=0;i<6;i++) {
      const stripe=new THREE.Mesh(new THREE.BoxGeometry(o.radius*.08,.083,.027),white);
      stripe.position.set(o.x+(i-2.5)*o.radius*.2,ground(o.x,o.z)+.09,o.z);stripe.rotation.z=-.4;group.add(stripe);
    }
    label('施工区域 · 请绕行',o.x,o.z);
  }
  if(demonstration) {
    const robot=state?.robots?.[0];
    const before=robot?.comparison?.before;
    const after=robot?.comparison?.after || (robot ? [[robot.x,robot.z],...(robot.path || [])] : []);
    function path(points:number[][],color:number,dashed:boolean) {
      if(!points?.length)return;
      const geometry=new THREE.BufferGeometry().setFromPoints(points.map(p=>new THREE.Vector3(p[0],ground(p[0],p[1])+.015,p[1])));
      const line=new THREE.Line(geometry,dashed?new THREE.LineDashedMaterial({color,dashSize:.12,gapSize:.07,depthTest:false}):new THREE.LineBasicMaterial({color,depthTest:false}));
      line.computeLineDistances();line.renderOrder=3;group.add(line);
    }
    path(before,0xffab4d,true);path(after,0x00bd9b,false);
    if(after?.length) {const end=after[after.length-1];ring(end[0],end[1],.12,0x00bd9b);label('巡检终点',end[0],end[1]);}
    const people=(state?.obstacles||[]).filter((o:any)=>o.kind==='行人');
    if(people.length)label('行人聚集 · 黄色为安全间距',people[0].x,people[0].z);
  }
  return group;
}

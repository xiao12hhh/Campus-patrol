import type { LocalFeature } from './campus';

export type Point = { x: number; z: number };
const CLEARANCE = 0.35; // Same swept radius as backend INFLATE; includes model and cornice.
function distance(p: Point, a: Point, b: Point) {
  const dx=b.x-a.x, dz=b.z-a.z;
  const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/(dx*dx+dz*dz || 1)));
  return Math.hypot(p.x-a.x-t*dx,p.z-a.z-t*dz);
}
function cross(a: Point,b: Point,c: Point) { return (b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x); }
function edgeDistance(a: Point,b: Point,c: Point,d: Point) {
  if(cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0) return 0;
  return Math.min(distance(a,c,d),distance(b,c,d),distance(c,a,b),distance(d,a,b));
}
function inside(p: Point,r: Point[]) {
  let yes=false;
  for(let i=0,j=r.length-1;i<r.length;j=i++) {
    const a=r[i],b=r[j];
    if((a.z>p.z)!==(b.z>p.z) && p.x<(b.x-a.x)*(p.z-a.z)/(b.z-a.z)+a.x) yes=!yes;
  }
  return yes;
}
export function robotCollision(features: LocalFeature[]) {
  const obstacles=features.filter(f=>f.kind==='building').flatMap(f=>{
    const g=f.geometry;
    const polygons=g.type==='Polygon' ? [g.coordinates] : g.type==='MultiPolygon' ? g.coordinates : [];
    return polygons.map((poly: number[][][])=>{
      const ring=poly[0].map(p=>({x:p[0],z:p[1]}));
      return {ring,x0:Math.min(...ring.map(p=>p.x)),x1:Math.max(...ring.map(p=>p.x)),
        z0:Math.min(...ring.map(p=>p.z)),z1:Math.max(...ring.map(p=>p.z))};
    });
  });
  return (a: Point,b: Point) => {
    for(const o of obstacles) {
      if(Math.max(a.x,b.x)+CLEARANCE<o.x0 || Math.min(a.x,b.x)-CLEARANCE>o.x1 ||
        Math.max(a.z,b.z)+CLEARANCE<o.z0 || Math.min(a.z,b.z)-CLEARANCE>o.z1) continue;
      if(inside(a,o.ring)||inside(b,o.ring)) return false;
      for(let i=0;i<o.ring.length;i++) if(edgeDistance(a,b,o.ring[i],o.ring[(i+1)%o.ring.length])<CLEARANCE-0.002) return false;
    }
    return true;
  };
}

/** Spend a distance budget along received segments; never predict beyond telemetry. */
export function advanceRobot(cur: Point, queue: Point[], distanceBudget: number, clear: (a: Point,b: Point)=>boolean): Point {
  let point=cur, remaining=Math.max(0,distanceBudget);
  while(queue.length && remaining>1e-9) {
    const next=queue[0];
    if(!clear(point,next)) break;
    const length=Math.hypot(next.x-point.x,next.z-point.z);
    if(length<=remaining+1e-9) {point=next;queue.shift();remaining=Math.max(0,remaining-length);}
    else {const fraction=remaining/length;point={x:point.x+(next.x-point.x)*fraction,z:point.z+(next.z-point.z)*fraction};remaining=0;}
  }
  return point;
}

/** The model faces -Z at zero yaw. Derive yaw from visible displacement. */
export function motionHeading(dx:number,dz:number) {return Math.atan2(-dx,-dz);}

/** Accumulated travel phase never jumps when speed changes or wall-clock time grows. */
export function travelPhase(phase:number, distance:number) {
  return (phase + Math.max(0,distance) / .1 * Math.PI * 2) % (Math.PI*2);
}

/** Perspective sprite height that occupies a fixed number of CSS pixels. */
export function labelWorldHeight(depth:number,fovDegrees:number,viewportHeight:number,pixels:number) {
  return 2*Math.max(0,depth)*Math.tan(fovDegrees*Math.PI/360)*pixels/Math.max(1,viewportHeight);
}

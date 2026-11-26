import { Vector3 } from 'three';

export type WallDistance = (direction: Vector3, length: number) => number | undefined;

export const MIN_FOLLOW_DISTANCE = .22;

/** Find a clear camera direction without squeezing into the robot's body. */
export function constrainFollowCamera(focus: Vector3, point: Vector3, wallDistance: WallDistance) {
  const offset=point.clone().sub(focus);
  if(offset.lengthSq()<1e-8)offset.set(0,.2,.4);
  offset.y=Math.max(.08,offset.y);
  const length=Math.max(MIN_FOLLOW_DISTANCE,offset.length());
  const direction=offset.normalize(), up=new Vector3(0,1,0);
  const candidates=[direction];
  for(const angle of [Math.PI/4,-Math.PI/4,Math.PI/2,-Math.PI/2,Math.PI]) {
    candidates.push(direction.clone().applyAxisAngle(up,angle));
  }
  candidates.push(direction.clone().add(up).normalize(),up);
  for(const candidate of candidates) {
    const hit=wallDistance(candidate,length+.04);
    const available=hit === undefined ? length : Math.min(length,hit-.04);
    if(available>=MIN_FOLLOW_DISTANCE) {
      return point.copy(focus).addScaledVector(candidate,available);
    }
  }
  // In a fully enclosed corner, keep the body exclusion zone even if no perfect view exists.
  point.copy(focus).addScaledVector(up,MIN_FOLLOW_DISTANCE);
  return point;
}

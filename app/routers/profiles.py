from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Profile

router = APIRouter()


class ProfileIn(BaseModel):
    name: str
    model: str = ""
    system_prompt: str = ""


def _public(p: Profile) -> dict:
    return {"id": p.id, "name": p.name, "model": p.model, "system_prompt": p.system_prompt}


@router.get("/api/profiles")
def list_profiles(db: Session = Depends(get_db)):
    profiles = db.query(Profile).order_by(Profile.name).all()
    return [_public(p) for p in profiles]


@router.post("/api/profiles")
def create_profile(body: ProfileIn, db: Session = Depends(get_db)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name is required.")
    profile = Profile(name=name, model=body.model.strip(), system_prompt=body.system_prompt)
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return _public(profile)


@router.put("/api/profiles/{profile_id}")
def update_profile(profile_id: int, body: ProfileIn, db: Session = Depends(get_db)):
    profile = db.get(Profile, profile_id)
    if not profile:
        raise HTTPException(404, "Not found")
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name is required.")
    profile.name = name
    profile.model = body.model.strip()
    profile.system_prompt = body.system_prompt
    db.commit()
    return _public(profile)


@router.delete("/api/profiles/{profile_id}")
def delete_profile(profile_id: int, db: Session = Depends(get_db)):
    profile = db.get(Profile, profile_id)
    if not profile:
        raise HTTPException(404, "Not found")
    db.delete(profile)
    db.commit()
    return {"ok": True}

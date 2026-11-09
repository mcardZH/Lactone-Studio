! This file is part of the Ester Studio modification of xTB.
! Copyright (C) 2026 Ester Studio contributors.
! Licensed under LGPL-3.0-or-later, as part of xTB; the application license
! does not restrict this third-party modification. No warranty is provided.
! See the corresponding xTB COPYING/ COPYING.LESSER license files.
! Ester Studio modification, 2026-11-05. Applied after automatic mdinitu
! only. The caller supplies xTB's actual mass and effective DOF definition.
subroutine es_initial_velocity_cap(n,iat,velo,mass,nfreedom,kboltz)
   use, intrinsic :: ieee_arithmetic, only : ieee_is_finite
   implicit none
   integer, intent(in) :: n,iat(n)
   real(wp), intent(inout) :: velo(3,n)
   real(wp), intent(in) :: mass(n),nfreedom,kboltz
   real(wp) :: before,after,kh,knh,kmax,tbefore,tafter,scale,ki
   integer :: i,triggered,nh
   kh=0.0_wp
   knh=0.0_wp
   nh=0
   do i=1,n
      ki=0.5_wp*mass(i)*sum(velo(:,i)**2)
      if(iat(i)==1)then
         kh=kh+ki
         nh=nh+1
      else
         knh=knh+ki
      endif
   enddo
   ! Use xTB's own accumulation order for the strict trigger and reported T.
   call ekinet(n,velo,mass,before)
   if(.not.ieee_is_finite(before).or.nfreedom<=0.or.kboltz<=0) &
      error stop 'ES_MD_INITIAL_VELOCITY_INVALID'
   tbefore=2.0_wp*before/(nfreedom*kboltz)
   kmax=0.5_wp*nfreedom*kboltz*8000.0_wp
   scale=1.0_wp
   triggered=0
   if(tbefore>8000.0_wp)then
      if(kh<=0.or.knh>=kmax) &
         error stop 'ES_MD_INITIAL_H_ONLY_INFEASIBLE'
      scale=sqrt((kmax-knh)/kh)
      do i=1,n
         if(iat(i)==1)velo(:,i)=velo(:,i)*scale
      enddo
      triggered=1
   endif
   call ekinet(n,velo,mass,after)
   tafter=2.0_wp*after/(nfreedom*kboltz)
   ! Internal provenance, parsed by the owner; never a normal UI warning.
   write(*,'(a,1x,i1,1x,i0,1x,9(es25.17e3,1x))') &
      'ES_MD_INIT_V1',triggered,nh,nfreedom,before,after,tbefore,tafter,scale,kh,knh,kboltz
end subroutine es_initial_velocity_cap

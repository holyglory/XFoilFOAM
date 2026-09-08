#include "fvCFD.H"
#include "psiThermo.H"
#include "directionInterpolate.H"
#include <cmath>
#include <iomanip>
#include <iostream>

using namespace Foam;

int main(int argc, char** argv)
{
    argList::noParallel();
    #include "setRootCase.H"
    #include "createTime.H"
    #include "createMesh.H"

    autoPtr<psiThermo> material = psiThermo::New(mesh);
    volScalarField density("rho", material->rho());
    volVectorField velocity
    (
        IOobject("U", runTime.timeName(), mesh, IOobject::MUST_READ, IOobject::NO_WRITE),
        mesh
    );
    volVectorField momentum("rhoU", density*velocity);
    volScalarField soundSpeed("c", sqrt(material->Cp()/material->Cv()/material->psi()));
    surfaceScalarField forwardDirection
    (
        IOobject("pos", runTime.timeName(), mesh), mesh,
        dimensionedScalar("positive", dimless, 1)
    );
    surfaceScalarField backwardDirection
    (
        IOobject("neg", runTime.timeName(), mesh), mesh,
        dimensionedScalar("negative", dimless, -1)
    );
    surfaceScalarField forwardDensity(interpolate(density, forwardDirection));
    surfaceScalarField backwardDensity(interpolate(density, backwardDirection));
    if (gMin(forwardDensity) <= 0 || gMin(backwardDensity) <= 0)
        return 2;
    surfaceVectorField forwardVelocity
    (
        interpolate(momentum, forwardDirection, velocity.name())/forwardDensity
    );
    surfaceVectorField backwardVelocity
    (
        interpolate(momentum, backwardDirection, velocity.name())/backwardDensity
    );
    surfaceScalarField forwardVolumeFlux(forwardVelocity & mesh.Sf());
    surfaceScalarField backwardVolumeFlux(backwardVelocity & mesh.Sf());
    forwardVolumeFlux.setOriented(false);
    backwardVolumeFlux.setOriented(false);
    surfaceScalarField forwardSoundFlux
    (
        interpolate(soundSpeed, forwardDirection, material->T().name())*mesh.magSf()
    );
    surfaceScalarField backwardSoundFlux
    (
        interpolate(soundSpeed, backwardDirection, material->T().name())*mesh.magSf()
    );
    const dimensionedScalar zeroFlux("zeroFlux", dimVolume/dimTime, Zero);
    surfaceScalarField positiveWave
    (
        max(max(forwardVolumeFlux + forwardSoundFlux, backwardVolumeFlux + backwardSoundFlux), zeroFlux)
    );
    surfaceScalarField negativeWave
    (
        min(min(forwardVolumeFlux - forwardSoundFlux, backwardVolumeFlux - backwardSoundFlux), zeroFlux)
    );
    surfaceScalarField forwardWeight(positiveWave/(positiveWave - negativeWave));
    surfaceScalarField forwardFlux(forwardWeight*(forwardVolumeFlux - negativeWave));
    surfaceScalarField backwardFlux((scalar(1) - forwardWeight)*(backwardVolumeFlux - positiveWave));
    const word fluxScheme = mesh.schemesDict().get<word>("fluxScheme");
    if (fluxScheme == "Tadmor")
    {
        surfaceScalarField maximumWave(max(mag(positiveWave), mag(negativeWave)));
        forwardFlux = scalar(0.5)*(forwardVolumeFlux + maximumWave);
        backwardFlux = scalar(0.5)*(backwardVolumeFlux - maximumWave);
    }
    else if (fluxScheme != "Kurganov") return 3;
    volScalarField integratedFlux(fvc::surfaceSum(max(mag(forwardFlux), mag(backwardFlux))));
    if (gMin(mesh.V().field()) <= 0) return 4;
    const scalar courantRate = scalar(0.5)*gMax(integratedFlux.primitiveField()/mesh.V().field());
    const scalar maximumCourant = runTime.controlDict().get<scalar>("maxCo");
    const scalar requestedDeltaT = runTime.deltaTValue();
    if (!std::isfinite(courantRate) || courantRate <= 0 || !std::isfinite(maximumCourant)
        || maximumCourant <= 0 || !std::isfinite(requestedDeltaT) || requestedDeltaT <= 0)
        return 5;
    const scalar safeDeltaT = min(requestedDeltaT, maximumCourant/(scalar(1.2)*courantRate));
    std::cout << std::setprecision(17)
        << "XFOILFOAM_ACOUSTIC_STARTUP {\"version\":1,\"courant_rate\":" << courantRate
        << ",\"maximum_courant\":" << maximumCourant
        << ",\"requested_delta_t\":" << requestedDeltaT
        << ",\"safe_delta_t\":" << safeDeltaT << "}\n";
    return 0;
}

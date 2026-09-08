#include "fvCFD.H"
#include "functionObject.H"

using namespace Foam;

int main(int argc, char** argv)
{
    argList::noParallel();
    argList::addBoolOption("evolvingTurbulence", "Isolated must-reject turbulence fixture");
    #include "setRootCase.H"
    #include "createTime.H"
    #include "createMesh.H"
    volScalarField density(IOobject("rho", runTime.timeName(), mesh), mesh, dimensionedScalar("rho", dimDensity, 1));
    volVectorField momentum(IOobject("rhoU", runTime.timeName(), mesh), mesh, dimensionedVector("rhoU", dimDensity*dimVelocity, vector(1, 0, 0)));
    volScalarField energy(IOobject("rhoE", runTime.timeName(), mesh), mesh, dimensionedScalar("rhoE", dimPressure, 1));
    volScalarField turbulenceEnergy(IOobject("k", runTime.timeName(), mesh), mesh, dimensionedScalar("k", sqr(dimVelocity), 1));
    volScalarField turbulenceFrequency(IOobject("omega", runTime.timeName(), mesh), mesh, dimensionedScalar("omega", dimless/dimTime, 1));
    volScalarField reciprocalStep(IOobject("rDeltaT", runTime.timeName(), mesh), mesh, dimensionedScalar("rDeltaT", dimless/dimTime, 1));
    density.oldTime(); momentum.oldTime(); energy.oldTime(); turbulenceEnergy.oldTime(); turbulenceFrequency.oldTime();
    dictionary config;
    config.add("type", "xfoilfoamSteadyConvergence");
    config.add("referenceDensity", scalar(1));
    config.add("referenceSpeed", scalar(1));
    config.add("referenceLength", scalar(1));
    config.add("referenceSpecificEnergy", scalar(1));
    config.add("referenceTurbulenceEnergy", scalar(1));
    config.add("referenceTurbulenceFrequency", scalar(1));
    config.add("tolerance", scalar(1e-4));
    config.add("consecutiveSteps", label(100));
    autoPtr<functionObject> detector = functionObject::New("nativeSteadyProbe", runTime, config);
    const bool evolving = args.found("evolvingTurbulence");
    for (label iteration = 1; iteration <= 100; ++iteration)
    {
        ++runTime;
        density.primitiveFieldRef() += scalar(0);
        momentum.primitiveFieldRef() += vector::zero;
        energy.primitiveFieldRef() += scalar(0);
        turbulenceEnergy.primitiveFieldRef() += evolving ? scalar(0.01) : scalar(0);
        turbulenceFrequency.primitiveFieldRef() += evolving ? scalar(0.01) : scalar(0);
        detector->execute();
    }
    return 0;
}

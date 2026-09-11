#include "fvCFD.H"
#include "fvMeshFunctionObject.H"
#include "addToRunTimeSelectionTable.H"
#include <cmath>

namespace Foam
{
namespace functionObjects
{
class xfoilfoamSteadyConvergence : public fvMeshFunctionObject
{
    scalar densityScale_;
    scalar momentumScale_;
    scalar energyScale_;
    scalar turbulenceEnergyScale_;
    scalar turbulenceFrequencyScale_;
    scalar tolerance_;
    label requiredSteps_;
    label stableSteps_ = 0;
    label observedSteps_ = 0;
    scalar maximumWindowResidual_ = 0;
    label lastTimeIndex_ = -1;
    bool primitiveFields_ = false;
    word energyField_ = "e";

public:
    TypeName("xfoilfoamSteadyConvergence");

    xfoilfoamSteadyConvergence(const word& name, const Time& runtime, const dictionary& config)
    : fvMeshFunctionObject(name, runtime, config)
    {
        read(config);
    }

    bool read(const dictionary& config) override
    {
        fvMeshFunctionObject::read(config);
        const scalar density = config.get<scalar>("referenceDensity");
        const scalar speed = config.get<scalar>("referenceSpeed");
        const scalar length = config.get<scalar>("referenceLength");
        const scalar specificEnergy = config.get<scalar>("referenceSpecificEnergy");
        const scalar turbulenceEnergy = config.get<scalar>("referenceTurbulenceEnergy");
        const scalar turbulenceFrequency = config.get<scalar>("referenceTurbulenceFrequency");
        tolerance_ = config.get<scalar>("tolerance");
        requiredSteps_ = config.get<label>("consecutiveSteps");
        const word fieldMode = config.getOrDefault<word>("conservedFields", "stored");
        energyField_ = config.getOrDefault<word>("energyField", "e");
        if ((fieldMode != "stored" && fieldMode != "primitive")
            || (fieldMode == "primitive" && energyField_ != "e" && energyField_ != "h"))
        {
            FatalIOErrorInFunction(config) << "Invalid conserved-field source" << exit(FatalIOError);
        }
        primitiveFields_ = fieldMode == "primitive";
        if (!std::isfinite(density) || density <= 0 || !std::isfinite(speed) || speed <= 0
            || !std::isfinite(length) || length <= 0 || !std::isfinite(specificEnergy) || specificEnergy <= 0
            || !std::isfinite(turbulenceEnergy) || turbulenceEnergy <= 0
            || !std::isfinite(turbulenceFrequency) || turbulenceFrequency <= 0
            || !std::isfinite(tolerance_) || tolerance_ <= 0 || requiredSteps_ < 100)
        {
            FatalIOErrorInFunction(config) << "Invalid local steady convergence reference" << exit(FatalIOError);
        }
        densityScale_ = density*speed/length;
        momentumScale_ = densityScale_*speed;
        energyScale_ = densityScale_*specificEnergy;
        turbulenceEnergyScale_ = turbulenceEnergy*speed/length;
        turbulenceFrequencyScale_ = turbulenceFrequency*speed/length;
        if (Pstream::master())
            Info << "XFOILFOAM_LOCAL_STEADY_FIELD_SOURCE " << fieldMode << " "
                << (primitiveFields_ ? energyField_ : word("rhoE")) << endl;
        stableSteps_ = 0;
        maximumWindowResidual_ = 0;
        return true;
    }

    bool execute() override
    {
        const label current = mesh_.time().timeIndex();
        if (current <= 0 || current == lastTimeIndex_) return true;
        lastTimeIndex_ = current;
        const auto& density = mesh_.lookupObject<volScalarField>("rho");
        const auto& turbulenceEnergy = mesh_.lookupObject<volScalarField>("k");
        const auto& turbulenceFrequency = mesh_.lookupObject<volScalarField>("omega");
        const auto& reciprocalStep = mesh_.lookupObject<volScalarField>("rDeltaT");
        const scalar minimumStep = gMin(reciprocalStep.primitiveField());
        const scalar maximumStep = gMax(reciprocalStep.primitiveField());
        if (!std::isfinite(minimumStep) || minimumStep <= 0 || !std::isfinite(maximumStep))
            FatalErrorInFunction << "Invalid local pseudo-time field" << exit(FatalError);
        const scalar densityResidual = gMax(mag(density.primitiveField() - density.oldTime().primitiveField())*reciprocalStep.primitiveField())/densityScale_;
        scalar momentumResidual;
        scalar energyResidual;
        if (primitiveFields_)
        {
            const auto& velocity = mesh_.lookupObject<volVectorField>("U");
            const auto& specificEnergy = mesh_.lookupObject<volScalarField>(energyField_);
            const vectorField momentum(density.primitiveField()*velocity.primitiveField());
            const vectorField previousMomentum(density.oldTime().primitiveField()*velocity.oldTime().primitiveField());
            scalarField energy(density.primitiveField()*(specificEnergy.primitiveField() + 0.5*magSqr(velocity.primitiveField())));
            scalarField previousEnergy(density.oldTime().primitiveField()*(specificEnergy.oldTime().primitiveField() + 0.5*magSqr(velocity.oldTime().primitiveField())));
            if (energyField_ == "h")
            {
                const auto& pressure = mesh_.lookupObject<volScalarField>("p");
                energy -= pressure.primitiveField();
                previousEnergy -= pressure.oldTime().primitiveField();
            }
            momentumResidual = gMax(mag(momentum - previousMomentum)*reciprocalStep.primitiveField())/momentumScale_;
            energyResidual = gMax(mag(energy - previousEnergy)*reciprocalStep.primitiveField())/energyScale_;
        }
        else
        {
            const auto& momentum = mesh_.lookupObject<volVectorField>("rhoU");
            const auto& energy = mesh_.lookupObject<volScalarField>("rhoE");
            momentumResidual = gMax(mag(momentum.primitiveField() - momentum.oldTime().primitiveField())*reciprocalStep.primitiveField())/momentumScale_;
            energyResidual = gMax(mag(energy.primitiveField() - energy.oldTime().primitiveField())*reciprocalStep.primitiveField())/energyScale_;
        }
        const scalar turbulenceEnergyResidual = gMax(mag(turbulenceEnergy.primitiveField() - turbulenceEnergy.oldTime().primitiveField())*reciprocalStep.primitiveField())/turbulenceEnergyScale_;
        const scalar turbulenceFrequencyResidual = gMax(mag(turbulenceFrequency.primitiveField() - turbulenceFrequency.oldTime().primitiveField())*reciprocalStep.primitiveField())/turbulenceFrequencyScale_;
        if (!std::isfinite(densityResidual) || !std::isfinite(momentumResidual) || !std::isfinite(energyResidual)
            || !std::isfinite(turbulenceEnergyResidual) || !std::isfinite(turbulenceFrequencyResidual))
            FatalErrorInFunction << "Nonfinite local steady residual" << exit(FatalError);
        const scalar maximum = max(max(densityResidual, max(momentumResidual, energyResidual)), max(turbulenceEnergyResidual, turbulenceFrequencyResidual));
        ++observedSteps_;
        if (maximum <= tolerance_)
        {
            ++stableSteps_;
            maximumWindowResidual_ = max(maximumWindowResidual_, maximum);
        }
        else
        {
            stableSteps_ = 0;
            maximumWindowResidual_ = 0;
        }
        if (Pstream::master())
            Info << "XFOILFOAM_LOCAL_STEADY_RESIDUAL " << current << " " << densityResidual
                << " " << momentumResidual << " " << energyResidual << " " << turbulenceEnergyResidual << " " << turbulenceFrequencyResidual << endl;
        if (stableSteps_ >= requiredSteps_ && observedSteps_ >= requiredSteps_)
        {
            if (Pstream::master())
                Info << "XFOILFOAM_LOCAL_STEADY_CONVERGED {\"version\":2,\"coordinate_kind\":\"iteration\",\"iteration\":"
                    << current << ",\"consecutive_steps\":" << stableSteps_
                    << ",\"tolerance\":" << tolerance_ << ",\"maximum_window_residual\":" << maximumWindowResidual_ << "}" << endl;
            const_cast<Time&>(mesh_.time()).writeAndEnd();
        }
        return true;
    }

    bool write() override { return true; }
};

defineTypeNameAndDebug(xfoilfoamSteadyConvergence, 0);
addToRunTimeSelectionTable(functionObject, xfoilfoamSteadyConvergence, dictionary);
}
}

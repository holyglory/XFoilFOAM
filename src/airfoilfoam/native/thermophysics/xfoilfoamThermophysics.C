#include "psiThermo.H"
#include "makeThermo.H"
#include "specie.H"
#include "perfectGas.H"
#include "janafThermo.H"
#include "sensibleInternalEnergy.H"
#include "thermo.H"
#include "polynomialTransport.H"
#include "hePsiThermo.H"
#include "pureMixture.H"

namespace Foam
{
    makeThermos
    (
        psiThermo,
        hePsiThermo,
        pureMixture,
        polynomialTransport,
        sensibleInternalEnergy,
        janafThermo,
        perfectGas,
        specie
    );
}
